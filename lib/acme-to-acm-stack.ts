/**
 * ACME to ACM メインスタック
 *
 * ACME プロトコルを使用して SSL/TLS 証明書を自動取得し、
 * AWS Certificate Manager (ACM) にインポートするシステムのメインスタック。
 *
 * 主要コンポーネント:
 * - S3 バケット: Certbot 状態と証明書バックアップの保存
 * - SNS トピック: 証明書更新の成功/失敗通知
 * - Lambda 関数: Docker イメージベースの証明書更新処理
 * - EventBridge スケジュール: 週次自動更新トリガー
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CertificateStorage } from './constructs/storage';
import { CertificateNotification } from './constructs/notification';
import { CertificateLambda } from './constructs/certificate-lambda';

/**
 * AcmeToAcmStack のプロパティ
 *
 * スタック作成時に指定可能な設定パラメータ
 */
export interface AcmeToAcmStackProps extends cdk.StackProps {
  /**
   * SNS 通知用のメールアドレス（オプション）
   * 指定した場合、デプロイ後に手動でサブスクリプションを承認する必要がある
   */
  notificationEmail?: string;

  /**
   * S3 内のドメイン設定ファイルキー
   * 証明書設定を格納する JSON ファイルのパス
   * @default 'config/domains.json'
   */
  domainConfigKey?: string;

  /**
   * 自動更新のスケジュール式（EventBridge cron）
   * UTC タイムゾーンで指定する
   * @default 'cron(0 17 ? * SUN *)' - 毎週日曜日 17:00 UTC（日本時間 2:00）
   */
  scheduleExpression?: string;

  /**
   * 自動更新スケジュールを有効にするか
   * false にすると EventBridge スケジュールが作成されず、手動実行のみになる
   * @default true
   */
  enableSchedule?: boolean;
}

/**
 * ACME to ACM 証明書更新システムのメイン CDK スタック
 *
 * すべてのリソース（S3、SNS、Lambda、EventBridge）を作成し、
 * 証明書の自動更新システムを構築する。
 */
export class AcmeToAcmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: AcmeToAcmStackProps) {
    super(scope, id, props);

    // S3 バケットを作成（証明書ストレージ用）
    // Certbot 設定、domains.json、証明書バックアップを保存する
    const storage = new CertificateStorage(this, 'Storage');

    // SNS トピックを作成（通知用）
    // 証明書更新の成功/失敗をメール通知する
    const notification = new CertificateNotification(this, 'Notification');

    // Lambda 関数を作成（証明書更新処理用）
    // Docker イメージベースの Lambda で Certbot を実行し、
    // Route53 で DNS-01 チャレンジを行い、証明書を ACM にインポートする
    const certificateLambda = new CertificateLambda(this, 'CertificateLambda', {
      bucket: storage.bucket, // 証明書ストレージ用 S3 バケット
      snsTopic: notification.topic, // 通知用 SNS トピック
      domainConfigKey: props?.domainConfigKey, // domains.json のパス
      scheduleExpression: props?.scheduleExpression, // 自動更新スケジュール
      enableSchedule: props?.enableSchedule, // スケジュール有効化フラグ
    });

    // CloudFormation Outputs を追加
    // デプロイ後の情報を出力する

    // スタック名を出力
    new cdk.CfnOutput(this, 'StackName', {
      value: this.stackName,
      description: 'Stack name',
    });

    // デプロイされたリージョンを出力
    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'AWS Region',
    });

    // デプロイ後の初期設定手順を出力
    // ユーザーが次に実行すべき操作をガイドする
    new cdk.CfnOutput(this, 'InstructionsMessage', {
      value: [
        'Next steps:',
        `1. (Optional) Subscribe to SNS topic for notifications:`,
        `   aws sns subscribe --topic-arn ${notification.topic.topicArn} --protocol email --notification-endpoint your-email@example.com`,
        `2. Register ACME account (for JPRS, use EAB credentials):`,
        `   aws lambda invoke --function-name ${certificateLambda.function.functionName} --payload '{"mode":"register",...}' response.json`,
        `3. Obtain certificates using certonly mode (automatically creates/updates domains.json):`,
        `   aws lambda invoke --function-name ${certificateLambda.function.functionName} --payload '{"mode":"certonly",...}' response.json`,
        `4. Monitor CloudWatch Logs and test automatic renewal`,
      ].join('\n'),
      description: 'Post-deployment instructions',
    });
  }
}
