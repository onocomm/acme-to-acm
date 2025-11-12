/**
 * 証明書ストレージ用 S3 バケットの CDK Construct
 *
 * 以下のデータを保存する暗号化された S3 バケットを作成:
 * - certbot/: Certbot の設定とアカウント情報（ACME 登録状態）
 * - config/: domains.json（証明書設定ファイル）
 * - certificates/: 証明書バックアップ（タイムスタンプ付き）
 *
 * セキュリティ機能:
 * - S3 マネージド暗号化（SSE-S3）
 * - バージョニング有効化（誤削除からの復旧）
 * - パブリックアクセス完全ブロック
 * - スタック削除時も保持（RETAIN ポリシー）
 *
 * ライフサイクル管理:
 * - 90 日後に Glacier へ移行（certificates/ 配下）
 * - 180 日後に自動削除
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * CertificateStorage Construct のプロパティ
 */
export interface CertificateStorageProps {
  /**
   * バケット名のサフィックス（アカウント ID が接頭辞として付く）
   * 例: 空文字列の場合 → acme-to-acm-certificates-{account-id}
   *     "-dev" の場合 → acme-to-acm-certificates-{account-id}-dev
   */
  bucketNameSuffix?: string;
}

/**
 * 証明書ストレージ用 S3 バケットの Construct
 *
 * Certbot 状態、証明書設定、バックアップを安全に保存する
 * 暗号化されたバージョニング付き S3 バケットを作成する。
 */
export class CertificateStorage extends Construct {
  /**
   * 作成された S3 バケット
   * Lambda 関数や他のリソースからアクセスする際に使用
   */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: CertificateStorageProps) {
    super(scope, id);

    // AWS アカウント ID を取得してバケット名を生成
    // バケット名をアカウント ID で一意化することで、複数アカウントへのデプロイが可能
    const account = cdk.Stack.of(this).account;
    const bucketName = `acme-to-acm-certificates-${account}${props?.bucketNameSuffix || ''}`;

    // 証明書ストレージ用の S3 バケットを作成
    // セキュアな設定で、Certbot 状態と証明書バックアップを保存する
    this.bucket = new s3.Bucket(this, 'CertificateBucket', {
      bucketName: bucketName, // アカウント ID を含むバケット名
      encryption: s3.BucketEncryption.S3_MANAGED, // S3 マネージド暗号化（SSE-S3）
      versioned: true, // バージョニング有効（誤削除からの復旧が可能）
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // パブリックアクセスを完全にブロック
      removalPolicy: cdk.RemovalPolicy.RETAIN, // スタック削除時もバケットを保持（証明書を守る）
      lifecycleRules: [
        {
          id: 'DeleteOldCertificates',
          enabled: true,
          prefix: 'certificates/', // 証明書バックアップディレクトリのみに適用
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER, // コスト削減のため Glacier へ移行
              transitionAfter: cdk.Duration.days(90), // 90 日後に移行
            },
          ],
          expiration: cdk.Duration.days(180), // 180 日後に自動削除（古いバックアップ削除）
        },
      ],
    });

    // CloudFormation Outputs を追加
    // デプロイ後にバケット情報を確認できるようにする

    // バケット名を出力（手動での S3 操作に使用）
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for certificate storage',
      exportName: `AcmeToAcmBucketName${props?.bucketNameSuffix || ''}`,
    });

    // バケット ARN を出力（IAM ポリシーなどで使用）
    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucketArn,
      description: 'S3 bucket ARN',
      exportName: `AcmeToAcmBucketArn${props?.bucketNameSuffix || ''}`,
    });
  }
}
