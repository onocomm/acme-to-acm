/**
 * ACME to ACM Lambda ハンドラー
 *
 * ACME プロバイダー（JPRS、Let's Encrypt など）から SSL/TLS 証明書を取得し、
 * AWS Certificate Manager (ACM) にインポートする Lambda 関数のエントリーポイント。
 *
 * 3つの動作モード:
 * 1. register - ACME アカウントの登録（EAB 認証情報を使用）
 * 2. certonly - 手動での証明書取得（ペイロードパラメータから）
 * 3. renew - domains.json 設定に基づく自動更新
 */

import { Handler } from 'aws-lambda';
import {
  DomainConfiguration,
  CertificateConfig,
  LambdaEvent,
  LambdaResponse,
  RenewalResult,
  RegisterPayload,
  CertonlyPayload,
  RenewPayload,
} from './types/domain-config';
import { S3Manager } from './storage/s3-manager';
import { Notifier } from './notification/notifier';
import { CertbotRunner } from './certbot/runner';
import { CertificateManager } from './acm/certificate-manager';

/**
 * Lambda ハンドラー関数
 * ACME 証明書管理の 3 つのモード（register, certonly, renew）をルーティング
 */
export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  // Lambda 関数の開始をログ出力
  console.log('Starting ACME to ACM certificate management');
  console.log('Event:', JSON.stringify(event, null, 2));

  // イベントペイロードから動作モードを取得
  const mode = event.input.mode;

  // モードが指定されていない場合はエラー
  if (!mode) {
    throw new Error('Mode is required in event payload (register, certonly, or renew)');
  }

  // モードに応じて適切なハンドラー関数にルーティング
  switch (mode) {
    case 'register':
      // ACME アカウント登録モード
      return await handleRegisterMode(event as RegisterPayload);
    case 'certonly':
      // 手動証明書取得モード
      return await handleCertonlyMode(event as CertonlyPayload);
    case 'renew':
      // 自動更新モード
      return await handleRenewMode(event as RenewPayload);
    default:
      // 未知のモードの場合はエラー
      throw new Error(`Unknown mode: ${mode}`);
  }
};

/**
 * register モードのハンドラー: EAB を使用した ACME アカウント登録
 *
 * JPRS などの EAB（External Account Binding）が必要な ACME プロバイダーでは、
 * 一時的な EAB 認証情報（eabKid, eabHmacKey）を使用してアカウントを登録する必要がある。
 * 登録後、アカウント情報は S3 に保存され、以降の証明書取得で再利用される。
 *
 * @param event - EAB 認証情報、メールアドレス、サーバー URL を含む RegisterPayload
 * @returns 登録結果を含む LambdaResponse
 */
async function handleRegisterMode(event: RegisterPayload): Promise<LambdaResponse> {
  console.log('=== REGISTER MODE ===');
  console.log(`Email: ${event.input.email}`);
  console.log(`Server: ${event.input.server}`);

  // 環境変数から S3 バケット名と SNS トピック ARN を取得
  const bucketName = process.env.CERTIFICATE_BUCKET;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;

  // 必須の環境変数が設定されているか確認
  if (!bucketName || !snsTopicArn) {
    throw new Error('Required environment variables are missing');
  }

  // 各種マネージャーを初期化
  const s3Manager = new S3Manager(bucketName);
  const notifier = new Notifier(snsTopicArn);
  const certbotRunner = new CertbotRunner();

  try {
    // Certbot 作業用ディレクトリを初期化（/tmp/certbot 配下）
    certbotRunner.initialize();

    // S3 から既存の Certbot 設定をダウンロード（存在する場合）
    // 初回登録時は空だが、再登録の場合は既存のアカウント情報を取得
    await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());

    // EAB 認証情報を使用して ACME アカウントを登録
    // `certbot register --email <email> --server <server> --eab-kid <kid> --eab-hmac-key <key>` を実行
    console.log('Registering ACME account...');
    await certbotRunner.registerAccount(event);

    // 登録されたアカウント情報を S3 にアップロード（永続化）
    // Lambda の /tmp は揮発性なので、次回実行時に使用できるよう S3 に保存
    await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');

    console.log('Account registration completed successfully');

    // 成功通知を SNS 経由で送信
    await notifier.sendSuccess(
      `ACME account registered successfully for ${event.input.email} on ${event.input.server}`
    );

    // 成功レスポンスを返却
    return {
      statusCode: 200,
      body: {
        message: 'ACME account registered successfully',
        results: [],
        totalProcessed: 0,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 0,
      },
    };
  } catch (error: any) {
    // 登録失敗時のエラー処理
    console.error('Account registration failed:', error);

    // エラー通知を SNS 経由で送信
    await notifier.sendError(error, 'ACME account registration');

    // エラーレスポンスを返却
    return {
      statusCode: 500,
      body: {
        message: `Registration failed: ${error.message}`,
        results: [],
        totalProcessed: 0,
        totalSuccess: 0,
        totalFailed: 1,
        totalSkipped: 0,
      },
    };
  } finally {
    // Certbot の作業ディレクトリをクリーンアップ（/tmp の容量制限対策）
    certbotRunner.cleanup();
  }
}

/**
 * certonly モードのハンドラー: ペイロードから手動で証明書を取得
 *
 * イベントペイロードで指定されたドメイン、メール、サーバー URL などのパラメータを使用して、
 * ACME サーバーから証明書を取得し、ACM にインポートする。
 * 取得成功後、自動的に domains.json に証明書設定を追加し、以降の自動更新の対象とする。
 *
 * 前提条件: ACME アカウントが事前に登録されていること（register モードを先に実行）
 *
 * @param event - ドメイン、メール、サーバー URL などを含む CertonlyPayload
 * @returns 証明書取得結果を含む LambdaResponse
 */
async function handleCertonlyMode(event: CertonlyPayload): Promise<LambdaResponse> {
  console.log('=== CERTONLY MODE ===');
  console.log(`Domains: ${event.input.domains.join(', ')}`);
  console.log(`Email: ${event.input.email}`);
  console.log(`Server: ${event.input.server}`);

  // 環境変数から S3 バケット名と SNS トピック ARN を取得
  const bucketName = process.env.CERTIFICATE_BUCKET;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;

  // 必須の環境変数が設定されているか確認
  if (!bucketName || !snsTopicArn) {
    throw new Error('Required environment variables are missing');
  }

  // 各種マネージャーを初期化
  const s3Manager = new S3Manager(bucketName);
  const notifier = new Notifier(snsTopicArn);
  const certbotRunner = new CertbotRunner();
  const certificateManager = new CertificateManager();

  try {
    // Certbot 作業用ディレクトリを初期化
    certbotRunner.initialize();

    // S3 から既存の Certbot 設定をダウンロード（登録済みアカウント情報が必要）
    await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());

    // Certbot を使用して ACME サーバーから証明書を取得
    // Route53 DNS-01 チャレンジで自動検証を実行
    console.log('Obtaining certificate from ACME server...');
    const certPaths = await certbotRunner.obtainCertificateFromPayload(event);

    // 証明書 ID を生成（手動取得の場合は "manual-" プレフィックスを付与）
    const certId = `manual-${event.input.domains[0].replace(/[^a-zA-Z0-9]/g, '-')}`;

    // 取得した証明書ファイルを S3 にバックアップ（タイムスタンプ付き）
    console.log('Backing up certificate to S3...');
    await s3Manager.saveCertificateBackup(
      certId,
      certPaths.certPath,
      certPaths.privateKeyPath,
      certPaths.chainPath,
      certPaths.fullChainPath
    );

    // 証明書を ACM にインポート（既存 ARN が指定されている場合は再インポート）
    console.log('Importing certificate to ACM...');
    const acmArn = await certificateManager.importCertificate(
      certPaths,
      certId,
      event.input.acmCertificateArn || null
    );

    // ACM から証明書情報を取得（有効期限などのメタデータ）
    const certInfo = await certificateManager.getCertificateInfo(acmArn);

    console.log('Certificate obtained and imported successfully');
    console.log(`ACM ARN: ${acmArn}`);

    // Certbot 設定を S3 に同期（証明書取得履歴を保存）
    await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');

    // domains.json に証明書設定を追加（自動更新の対象とするため）
    const domainConfigKey = process.env.DOMAIN_CONFIG_KEY || 'config/domains.json';
    let config: DomainConfiguration;

    try {
      // 既存の domains.json を S3 からダウンロード
      const configJson = await s3Manager.downloadConfig(domainConfigKey);
      config = JSON.parse(configJson);
      console.log('Loaded existing domains.json configuration');
    } catch (error) {
      // domains.json が存在しない場合は新規作成
      console.log('domains.json not found, creating new configuration');
      config = {
        version: '1.0',
        certificates: [],
      };
    }

    // 新しい証明書設定を作成
    const newCertConfig: CertificateConfig = {
      id: certId,
      domains: event.input.domains,
      email: event.input.email,
      acmeProvider: 'custom', // カスタムサーバー URL を使用
      acmeServerUrl: event.input.server,
      route53HostedZoneId: event.input.route53HostedZoneId,
      acmCertificateArn: acmArn,
      renewDaysBeforeExpiry: 30, // 有効期限の 30 日前に更新
      enabled: true, // 自動更新を有効化
      keyType: event.input.keyType || 'rsa', // RSA または ECDSA
      rsaKeySize: event.input.rsaKeySize, // RSA キーサイズ（指定がある場合）
    };

    // 証明書設定を配列に追加
    config.certificates.push(newCertConfig);

    // 更新された domains.json を S3 にアップロード
    await s3Manager.uploadFile(
      domainConfigKey,
      JSON.stringify(config, null, 2)
    );

    console.log(`Added certificate ${certId} to domains.json configuration`);

    // 成功通知を SNS 経由で送信
    await notifier.sendSuccess(
      `Certificate obtained successfully for ${event.input.domains.join(', ')}\nACM ARN: ${acmArn}\nAdded to domains.json for automatic renewal`
    );

    // 処理結果を作成
    const result: RenewalResult = {
      certificateId: certId,
      domains: event.input.domains,
      success: true,
      acmCertificateArn: acmArn,
      expiryDate: certInfo?.notAfter,
    };

    // 成功レスポンスを返却
    return {
      statusCode: 200,
      body: {
        message: 'Certificate obtained and imported successfully',
        results: [result],
        totalProcessed: 1,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 0,
      },
    };
  } catch (error: any) {
    // 証明書取得失敗時のエラー処理
    console.error('Certificate acquisition failed:', error);

    // エラー通知を SNS 経由で送信
    await notifier.sendError(error, 'Certificate acquisition');

    // エラー結果を作成
    const result: RenewalResult = {
      certificateId: `manual-${event.input.domains[0].replace(/[^a-zA-Z0-9]/g, '-')}`,
      domains: event.input.domains,
      success: false,
      error: error.message,
    };

    // エラーレスポンスを返却
    return {
      statusCode: 500,
      body: {
        message: `Certificate acquisition failed: ${error.message}`,
        results: [result],
        totalProcessed: 1,
        totalSuccess: 0,
        totalFailed: 1,
        totalSkipped: 0,
      },
    };
  } finally {
    // Certbot の作業ディレクトリをクリーンアップ
    certbotRunner.cleanup();
  }
}

/**
 * renew モードのハンドラー: domains.json に基づく自動更新
 *
 * S3 の domains.json から証明書設定を読み込み、有効化されている証明書を順次処理する。
 * 各証明書について有効期限をチェックし、更新が必要な場合のみ Certbot で証明書を取得して ACM に再インポートする。
 * EventBridge スケジュール（デフォルト: 毎週日曜日 2:00 JST）から定期的に呼び出される。
 *
 * @param event - dryRun フラグや対象証明書 ID フィルタを含む RenewPayload
 * @returns 全証明書の処理結果を含む LambdaResponse
 */
async function handleRenewMode(event: RenewPayload): Promise<LambdaResponse> {
  console.log('=== RENEW MODE ===');
  console.log(`Dry run: ${event.input.dryRun || false}`);

  // 環境変数を取得
  const bucketName = process.env.CERTIFICATE_BUCKET;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;
  const domainConfigKey = process.env.DOMAIN_CONFIG_KEY || 'config/domains.json';

  // 必須の環境変数が設定されているか確認
  if (!bucketName || !snsTopicArn) {
    throw new Error('Required environment variables are missing');
  }

  // 各種マネージャーを初期化
  const s3Manager = new S3Manager(bucketName);
  const notifier = new Notifier(snsTopicArn);
  const certbotRunner = new CertbotRunner();
  const certificateManager = new CertificateManager();

  // 処理結果を格納する配列
  const results: RenewalResult[] = [];

  try {
    // Certbot 作業用ディレクトリを初期化
    certbotRunner.initialize();

    // S3 から domains.json をダウンロード
    console.log('Downloading domain configuration...');
    const configJson = await s3Manager.downloadConfig(domainConfigKey);
    const config: DomainConfiguration = JSON.parse(configJson);

    console.log(`Loaded configuration version ${config.version} with ${config.certificates.length} certificates`);

    // S3 から既存の Certbot 設定をダウンロード（アカウント情報と証明書履歴）
    await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());

    // 各証明書設定を順次処理
    for (const certConfig of config.certificates) {
      // 無効化されている証明書はスキップ
      if (!certConfig.enabled) {
        console.log(`Skipping disabled certificate: ${certConfig.id}`);
        results.push({
          certificateId: certConfig.id,
          domains: certConfig.domains,
          success: false,
          skipped: true,
          skipReason: 'Certificate is disabled in configuration',
        });
        continue;
      }

      // イベントペイロードで証明書 ID フィルタが指定されている場合、対象外はスキップ
      if (event.input.certificateIds && !event.input.certificateIds.includes(certConfig.id)) {
        console.log(`Skipping certificate not in event filter: ${certConfig.id}`);
        continue;
      }

      // 証明書を処理（有効期限チェック、取得、ACM インポート）
      const result = await processCertificate(
        certConfig,
        s3Manager,
        certbotRunner,
        certificateManager,
        event.input.dryRun || false
      );

      results.push(result);
    }

    // Certbot 設定を S3 に同期（新しい証明書取得履歴を保存）
    await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');

    // 処理結果のサマリー通知を SNS 経由で送信
    await notifier.sendRenewalSummary(results);

    // サマリー統計を計算
    const summary = {
      totalProcessed: results.length,
      totalSuccess: results.filter(r => r.success).length,
      totalFailed: results.filter(r => r.success === false && !r.skipped).length,
      totalSkipped: results.filter(r => r.skipped).length,
    };

    console.log('Certificate renewal completed');
    console.log('Summary:', summary);

    // 成功レスポンスを返却
    return {
      statusCode: 200,
      body: {
        message: 'Certificate renewal process completed',
        results,
        ...summary,
      },
    };
  } catch (error: any) {
    // 致命的エラー（domains.json が存在しない、S3 アクセス失敗など）
    console.error('Critical error:', error);

    // エラー通知を SNS 経由で送信
    await notifier.sendError(error, 'Certificate renewal process');

    // エラーレスポンスを返却
    return {
      statusCode: 500,
      body: {
        message: `Error: ${error.message}`,
        results,
        totalProcessed: results.length,
        totalSuccess: results.filter(r => r.success).length,
        totalFailed: results.filter(r => !r.success && !r.skipped).length,
        totalSkipped: results.filter(r => r.skipped).length,
      },
    };
  } finally {
    // Certbot の作業ディレクトリをクリーンアップ
    certbotRunner.cleanup();
  }
}

/**
 * 単一の証明書を処理する
 *
 * 証明書の有効期限をチェックし、更新が必要な場合は以下の処理を実行する:
 * 1. Certbot で ACME サーバーから新しい証明書を取得
 * 2. 証明書ファイルを S3 にバックアップ
 * 3. 証明書を ACM にインポート（既存 ARN がある場合は再インポート）
 *
 * @param config - 証明書設定（domains.json の 1 エントリ）
 * @param s3Manager - S3 操作マネージャー
 * @param certbotRunner - Certbot 実行マネージャー
 * @param certificateManager - ACM 操作マネージャー
 * @param dryRun - true の場合、実際の証明書取得はスキップ（テスト用）
 * @returns 処理結果
 */
async function processCertificate(
  config: CertificateConfig,
  s3Manager: S3Manager,
  certbotRunner: CertbotRunner,
  certificateManager: CertificateManager,
  dryRun: boolean
): Promise<RenewalResult> {
  // 処理中の証明書情報をログ出力
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing certificate: ${config.id}`);
  console.log(`Domains: ${config.domains.join(', ')}`);
  console.log(`Provider: ${config.acmeProvider}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // ACM ARN が設定されている場合、有効期限をチェック
    if (config.acmCertificateArn) {
      const needsRenewal = await certificateManager.needsRenewal(
        config.acmCertificateArn,
        config.renewDaysBeforeExpiry
      );

      // 更新の必要がない場合はスキップ
      if (!needsRenewal) {
        console.log('Certificate does not need renewal yet');
        return {
          certificateId: config.id,
          domains: config.domains,
          success: false,
          skipped: true,
          skipReason: 'Certificate is still valid and not due for renewal',
          acmCertificateArn: config.acmCertificateArn,
        };
      }
    }

    // ドライランモードの場合、実際の証明書取得はスキップ
    if (dryRun) {
      console.log('DRY RUN: Skipping actual certificate obtainment');
      return {
        certificateId: config.id,
        domains: config.domains,
        success: true,
        skipped: true,
        skipReason: 'Dry run mode - no actual changes made',
      };
    }

    // Certbot を使用して ACME サーバーから証明書を取得
    console.log('Obtaining certificate from ACME server...');
    const certPaths = await certbotRunner.obtainCertificate(config);

    // 取得した証明書ファイルを S3 にバックアップ（タイムスタンプ付き）
    console.log('Backing up certificate to S3...');
    await s3Manager.saveCertificateBackup(
      config.id,
      certPaths.certPath,
      certPaths.privateKeyPath,
      certPaths.chainPath,
      certPaths.fullChainPath
    );

    // 証明書を ACM にインポート（既存 ARN がある場合は再インポート）
    console.log('Importing certificate to ACM...');
    const acmArn = await certificateManager.importCertificate(
      certPaths,
      config.id,
      config.acmCertificateArn
    );

    // ACM から証明書情報を取得（有効期限などのメタデータ）
    const certInfo = await certificateManager.getCertificateInfo(acmArn);

    console.log(`Certificate ${config.id} processed successfully`);
    console.log(`ACM ARN: ${acmArn}`);

    // 成功結果を返却
    return {
      certificateId: config.id,
      domains: config.domains,
      success: true,
      acmCertificateArn: acmArn,
      expiryDate: certInfo?.notAfter,
    };
  } catch (error: any) {
    // 証明書処理失敗時のエラー処理
    console.error(`Failed to process certificate ${config.id}:`, error);

    // エラー結果を返却（renew モード全体は継続）
    return {
      certificateId: config.id,
      domains: config.domains,
      success: false,
      error: error.message,
    };
  }
}
