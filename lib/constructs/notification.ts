/**
 * 証明書更新通知用 SNS トピックの CDK Construct
 *
 * 証明書の自動更新プロセスの成功/失敗を通知する SNS トピックを作成する。
 *
 * 通知内容:
 * - 成功時: 更新された証明書の一覧と有効期限
 * - 失敗時: エラーメッセージとスタックトレース
 *
 * 使用方法:
 * 1. デプロイ後、手動でメールサブスクリプションを追加
 * 2. AWS Console または CLI でサブスクリプション承認
 * 3. Lambda 関数が通知を自動送信
 */

import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * CertificateNotification Construct のプロパティ
 *
 * 現在は未使用だが、将来の拡張のために定義
 * （例: デフォルトのメールアドレス、通知フィルターなど）
 */
export interface CertificateNotificationProps {
  /**
   * 将来の設定オプション用のプレースホルダー
   */
}

/**
 * 証明書更新通知用 SNS トピックの Construct
 *
 * Lambda 関数が証明書更新結果をパブリッシュする SNS トピックを作成する。
 * 管理者はこのトピックにメールアドレスをサブスクライブして通知を受け取る。
 */
export class CertificateNotification extends Construct {
  /**
   * 作成された SNS トピック
   * Lambda 関数が通知をパブリッシュする際に使用
   */
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props?: CertificateNotificationProps) {
    super(scope, id);

    // SNS トピックを作成（証明書更新通知用）
    // Lambda 関数がこのトピックに更新結果をパブリッシュする
    this.topic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'ACME to ACM Certificate Renewal Notifications', // 表示名
      topicName: 'AcmeToAcmNotifications', // トピック名
    });

    // 注意: メールサブスクリプションは管理者が手動で追加する必要がある
    // CDK でメール購読を自動作成すると、毎回デプロイで承認メールが送信されるため
    //
    // 手動サブスクリプション追加コマンド:
    // aws sns subscribe --topic-arn <ARN> --protocol email --notification-endpoint <EMAIL>
    //
    // または AWS Console から:
    // SNS > Topics > AcmeToAcmNotifications > Create subscription

    // CloudFormation Outputs を追加
    // デプロイ後にトピック情報を確認できるようにする

    // トピック ARN を出力（サブスクリプション追加に使用）
    new cdk.CfnOutput(this, 'TopicArn', {
      value: this.topic.topicArn,
      description: 'SNS topic ARN for certificate notifications',
      exportName: 'AcmeToAcmTopicArn',
    });

    // トピック名を出力（参照用）
    new cdk.CfnOutput(this, 'TopicName', {
      value: this.topic.topicName,
      description: 'SNS topic name',
      exportName: 'AcmeToAcmTopicName',
    });
  }
}
