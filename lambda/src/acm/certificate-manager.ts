/**
 * AWS Certificate Manager (ACM) 操作マネージャー
 *
 * ACM への証明書インポート、証明書情報取得、有効期限チェックなどの機能を提供する。
 * CloudFront で使用する証明書は us-east-1 リージョンに存在する必要がある。
 */

import {
  ACMClient,
  ImportCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  AddTagsToCertificateCommand,
} from '@aws-sdk/client-acm';
import * as fs from 'fs';
import { CertbotCertificatePaths } from '../types/domain-config';

/**
 * ACM 証明書情報
 */
export interface CertificateInfo {
  arn: string; // 証明書 ARN
  domainName: string; // プライマリドメイン名
  notAfter?: Date; // 有効期限
  status?: string; // 証明書ステータス（ISSUED, PENDING_VALIDATION など）
}

/**
 * CertificateManager - ACM 操作を管理するクラス
 */
export class CertificateManager {
  private acmClient: ACMClient;

  /**
   * コンストラクタ
   * @param region - ACM リージョン（CloudFront 用は us-east-1 が必須、デフォルト）
   */
  constructor(region = 'us-east-1') {
    this.acmClient = new ACMClient({ region });
  }

  /**
   * ACM に証明書をインポート（または再インポート）
   *
   * Certbot で取得した証明書ファイルを ACM にインポートする。
   * 既存 ARN が指定されている場合は再インポート（証明書の更新）を実行。
   * 新規インポートの場合は、管理用タグを自動付与。
   *
   * @param certPaths - Certbot が生成した証明書ファイルのパス
   * @param certificateId - 証明書 ID（タグ付けに使用）
   * @param existingArn - 既存の証明書 ARN（再インポート時に指定）
   * @returns インポートされた証明書の ARN
   * @throws ACM が ARN を返さなかった場合にエラーをスロー
   */
  async importCertificate(
    certPaths: CertbotCertificatePaths,
    certificateId: string,
    existingArn?: string | null
  ): Promise<string> {
    console.log('Importing certificate to ACM...');

    // 証明書ファイルを読み込み
    const certificate = fs.readFileSync(certPaths.certPath); // 証明書のみ
    const privateKey = fs.readFileSync(certPaths.privateKeyPath); // 秘密鍵
    const certificateChain = fs.readFileSync(certPaths.chainPath); // 中間証明書チェーン

    // ACM ImportCertificate コマンドを構築
    const command = new ImportCertificateCommand({
      Certificate: certificate,
      PrivateKey: privateKey,
      CertificateChain: certificateChain,
      CertificateArn: existingArn || undefined, // 既存 ARN があれば再インポート
    });

    // ACM にインポート実行
    const response = await this.acmClient.send(command);

    // ACM からの応答検証
    if (!response.CertificateArn) {
      throw new Error('ACM did not return a certificate ARN');
    }

    console.log(`Certificate imported: ${response.CertificateArn}`);

    // 新規インポートの場合、管理用タグを付与
    if (!existingArn) {
      await this.tagCertificate(response.CertificateArn, certificateId);
    }

    return response.CertificateArn;
  }

  /**
   * ACM から証明書情報を取得
   *
   * 証明書の詳細情報（ドメイン名、有効期限、ステータスなど）を取得する。
   *
   * @param arn - 証明書 ARN
   * @returns 証明書情報（存在しない場合は null）
   * @throws ResourceNotFoundException 以外のエラーはそのままスロー
   */
  async getCertificateInfo(arn: string): Promise<CertificateInfo | null> {
    try {
      // ACM DescribeCertificate コマンドを実行
      const command = new DescribeCertificateCommand({
        CertificateArn: arn,
      });

      const response = await this.acmClient.send(command);

      // 証明書情報が存在しない場合
      if (!response.Certificate) {
        return null;
      }

      // 証明書情報を返却
      return {
        arn: arn,
        domainName: response.Certificate.DomainName || '',
        notAfter: response.Certificate.NotAfter, // 有効期限
        status: response.Certificate.Status, // ステータス
      };
    } catch (error: any) {
      // 証明書が存在しない場合は null を返却（エラーとしない）
      if (error.name === 'ResourceNotFoundException') {
        console.log(`Certificate not found: ${arn}`);
        return null;
      }
      // その他のエラーはそのままスロー
      throw error;
    }
  }

  /**
   * 証明書の更新が必要かチェック
   *
   * 証明書の有効期限を確認し、指定された日数以内に期限切れになる場合は true を返す。
   * 証明書情報が取得できない場合は、安全側に倒して更新が必要と判定。
   *
   * @param arn - 証明書 ARN
   * @param daysBeforeExpiry - 有効期限の何日前から更新するか（デフォルト: 30日）
   * @returns 更新が必要な場合は true
   */
  async needsRenewal(arn: string, daysBeforeExpiry: number): Promise<boolean> {
    // ACM から証明書情報を取得
    const info = await this.getCertificateInfo(arn);

    // 証明書情報が取得できない、または有効期限がない場合は更新推奨
    if (!info || !info.notAfter) {
      console.log('Certificate info not available, renewal recommended');
      return true;
    }

    // 現在日時と有効期限から残り日数を計算
    const now = new Date();
    const expiryDate = new Date(info.notAfter);
    const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    console.log(`Certificate expires in ${daysUntilExpiry} days (threshold: ${daysBeforeExpiry} days)`);

    // 残り日数がしきい値以下なら更新が必要
    return daysUntilExpiry <= daysBeforeExpiry;
  }

  /**
   * 証明書にメタデータタグを付与（private メソッド）
   *
   * 新規インポートされた証明書に管理用タグを付与する。
   * タグを使用して、どのシステムが管理しているか、最終更新日時などを記録。
   *
   * @param arn - 証明書 ARN
   * @param certificateId - 証明書 ID（domains.json の id フィールドと対応）
   */
  private async tagCertificate(arn: string, certificateId: string): Promise<void> {
    console.log(`Tagging certificate ${arn}`);

    // ACM AddTagsToCertificate コマンドを構築
    const command = new AddTagsToCertificateCommand({
      CertificateArn: arn,
      Tags: [
        {
          Key: 'ManagedBy',
          Value: 'acme-to-acm', // このシステムで管理されていることを示す
        },
        {
          Key: 'CertificateId',
          Value: certificateId, // domains.json の証明書 ID
        },
        {
          Key: 'LastRenewal',
          Value: new Date().toISOString(), // 最終更新日時（ISO 8601 形式）
        },
      ],
    });

    // タグ付与を実行
    await this.acmClient.send(command);
    console.log('Certificate tagged successfully');
  }

  /**
   * タグから証明書を検索（未実装）
   *
   * CertificateId タグから証明書 ARN を検索する機能。
   * 現在は未実装で、ARN は domains.json に保存されている前提。
   *
   * @param certificateId - 検索する証明書 ID
   * @returns 証明書 ARN（見つからない場合は null）
   */
  async findCertificateByTag(certificateId: string): Promise<string | null> {
    console.log(`Looking for certificate with tag CertificateId=${certificateId}`);

    // ISSUED（発行済み）ステータスの証明書リストを取得
    const listCommand = new ListCertificatesCommand({
      CertificateStatuses: ['ISSUED'],
    });

    const listResponse = await this.acmClient.send(listCommand);

    if (!listResponse.CertificateSummaryList) {
      return null;
    }

    // 注意: ListCertificates API はタグを返さないため、
    // 各証明書を個別に DescribeCertificate で調べる必要がある。
    // 現在は未実装で、ARN は domains.json に保存されている前提。
    // これは将来の機能拡張として残されている。

    return null;
  }
}
