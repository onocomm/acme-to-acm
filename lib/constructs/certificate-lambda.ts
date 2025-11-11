/**
 * 証明書更新 Lambda 関数の CDK Construct
 *
 * Docker イメージベースの Lambda 関数を作成し、以下を設定:
 * - S3、SNS、Route53、ACM への IAM パーミッション
 * - EventBridge スケジュールによる自動更新（週次）
 * - CloudFormation Outputs
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'path';
import { Construct } from 'constructs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';

/**
 * CertificateLambda Construct のプロパティ
 */
export interface CertificateLambdaProps {
  /**
   * 証明書ストレージ用の S3 バケット
   * Certbot 設定と証明書バックアップを保存
   */
  bucket: s3.IBucket;

  /**
   * 通知用の SNS トピック
   * 証明書更新の成功/失敗を通知
   */
  snsTopic: sns.ITopic;

  /**
   * S3 内のドメイン設定ファイルキー
   * @default 'config/domains.json'
   */
  domainConfigKey?: string;

  /**
   * 自動更新のスケジュール式（EventBridge cron）
   * @default 'cron(0 17 ? * SUN *)' - 毎週日曜日 2:00 JST（UTC 土曜日 17:00）
   */
  scheduleExpression?: string;

  /**
   * 自動更新スケジュールを有効にするか
   * @default true
   */
  enableSchedule?: boolean;
}

/**
 * 証明書更新 Lambda 関数の Construct
 *
 * Docker イメージから Lambda 関数を作成し、必要なパーミッションと
 * 自動実行スケジュールを設定する。
 */
export class CertificateLambda extends Construct {
  /**
   * 作成された Lambda 関数
   * 手動実行や他のリソースからの参照に使用可能
   */
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: CertificateLambdaProps) {
    super(scope, id);

    // デフォルト値を設定
    const domainConfigKey = props.domainConfigKey || 'config/domains.json';
    const scheduleExpression = props.scheduleExpression || 'cron(0 17 ? * SUN *)';
    const enableSchedule = props.enableSchedule !== false;

    // Docker イメージから Lambda 関数を作成
    // lambda/ ディレクトリの Dockerfile を使用してビルド
    this.function = new lambda.DockerImageFunction(this, 'RenewalFunction', {
      functionName: 'AcmeToAcmCertificateRenewer',
      description: 'ACME certificate renewal and ACM import',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../lambda'), // lambda/ ディレクトリを指定
        {
          file: 'Dockerfile',
          platform: Platform.LINUX_AMD64, // x86_64 アーキテクチャを使用
        }
      ),
      memorySize: 1024, // 1GB メモリ（Certbot 実行に十分）
      timeout: cdk.Duration.minutes(15), // 最大 15 分（Lambda の上限）
      ephemeralStorageSize: cdk.Size.mebibytes(2048), // /tmp に 2GB（Certbot 作業用）
      architecture: lambda.Architecture.X86_64,
      environment: {
        CERTIFICATE_BUCKET: props.bucket.bucketName, // S3 バケット名
        SNS_TOPIC_ARN: props.snsTopic.topicArn, // SNS トピック ARN
        DOMAIN_CONFIG_KEY: domainConfigKey, // domains.json のキー
        CERTBOT_DIR: '/tmp/certbot', // Certbot 作業ディレクトリ
      },
    });

    // Lambda 関数に必要なパーミッションを付与
    this.grantPermissions(props);

    // EventBridge スケジュールを作成（有効な場合）
    if (enableSchedule) {
      this.createSchedule(scheduleExpression);
    }

    // CloudFormation Outputs を追加
    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.function.functionArn,
      description: 'Lambda function ARN',
      exportName: 'AcmeToAcmFunctionArn',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.function.functionName,
      description: 'Lambda function name',
      exportName: 'AcmeToAcmFunctionName',
    });
  }

  /**
   * Lambda 関数に必要なパーミッションを付与
   *
   * 以下のサービスへのアクセス権を設定:
   * - S3: 証明書ストレージと設定ファイルの読み書き
   * - SNS: 通知の送信
   * - Route53: DNS-01 チャレンジによるドメイン検証
   * - ACM: 証明書のインポートと管理
   *
   * @param props - Construct プロパティ
   */
  private grantPermissions(props: CertificateLambdaProps): void {
    // S3 バケットへの読み書き権限
    // Certbot 設定、domains.json、証明書バックアップにアクセス
    props.bucket.grantReadWrite(this.function);

    // SNS トピックへのパブリッシュ権限
    // 証明書更新の成功/失敗通知を送信
    props.snsTopic.grantPublish(this.function);

    // Route53 グローバル操作の権限
    // ホストゾーンのリストアップと変更状態の確認
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'route53:ListHostedZones', // ホストゾーンのリスト取得
          'route53:GetChange', // DNS 変更の進捗確認
        ],
        resources: ['*'], // グローバル操作のため * が必要
      })
    );

    // Route53 ホストゾーン固有の操作権限
    // DNS-01 チャレンジで TXT レコードを追加/削除
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'route53:ChangeResourceRecordSets', // DNS レコードの変更
          'route53:GetHostedZone', // ホストゾーン情報の取得
          'route53:ListResourceRecordSets', // レコードセットのリスト
        ],
        resources: ['arn:aws:route53:::hostedzone/*'], // すべてのホストゾーン
      })
    );

    // ACM 操作の権限
    // 証明書のインポート、情報取得、タグ付け
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'acm:ImportCertificate', // 証明書のインポート/再インポート
          'acm:DescribeCertificate', // 証明書情報の取得（有効期限など）
          'acm:ListCertificates', // 証明書のリスト（タグ検索用、将来の機能）
          'acm:AddTagsToCertificate', // 証明書へのタグ付与
        ],
        resources: ['*'], // ACM は特定の ARN を事前に知ることができないため
      })
    );

    // 注意: CloudWatch Logs の権限は Lambda が自動的に付与
  }

  /**
   * 自動更新用の EventBridge スケジュールを作成
   *
   * 指定された cron 式に基づいて Lambda 関数を定期実行する。
   * デフォルトは毎週日曜日 2:00 JST（UTC 土曜日 17:00）。
   *
   * @param scheduleExpression - EventBridge cron 式
   */
  private createSchedule(scheduleExpression: string): void {
    // EventBridge Rule を作成
    const rule = new events.Rule(this, 'WeeklyRenewalSchedule', {
      ruleName: 'AcmeToAcmWeeklyCheck',
      description: 'Weekly certificate renewal check',
      schedule: events.Schedule.expression(scheduleExpression),
    });

    // Lambda 関数をターゲットとして追加
    // renew モードで実行するようペイロードを設定
    rule.addTarget(
      new targets.LambdaFunction(this.function, {
        event: events.RuleTargetInput.fromObject({
          mode: 'renew', // 自動更新モード
        }),
      })
    );

    // CloudFormation Outputs を追加
    new cdk.CfnOutput(this, 'ScheduleRuleName', {
      value: rule.ruleName,
      description: 'EventBridge schedule rule name',
    });

    new cdk.CfnOutput(this, 'ScheduleExpression', {
      value: scheduleExpression,
      description: 'Certificate renewal schedule',
    });
  }
}
