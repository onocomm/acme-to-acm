#!/usr/bin/env node
/**
 * ACME to ACM CDK アプリケーションのエントリーポイント
 *
 * CDK スタックを初期化し、デプロイ設定を指定する。
 * このファイルは `cdk deploy` コマンドによって実行される。
 *
 * 主要な設定:
 * - デプロイリージョン: us-east-1（CloudFront 証明書の要件）
 * - スタック名: AcmeToAcmStack
 * - タグ: プロジェクト管理用
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AcmeToAcmStack } from '../lib/acme-to-acm-stack';

// CDK アプリケーションを作成
const app = new cdk.App();

// スタック名サフィックスを環境変数から取得（オプション）
// 複数スタックをデプロイする場合に使用（例: STACK_SUFFIX=-jprs, STACK_SUFFIX=-letsencrypt）
const stackSuffix = process.env.STACK_SUFFIX || '';

// ACME to ACM スタックを作成してデプロイ
new AcmeToAcmStack(app, `AcmeToAcmStack${stackSuffix}`, {
  /**
   * デプロイ先の AWS アカウントとリージョン
   *
   * リージョン指定:
   * - CloudFront 用: us-east-1（デフォルト）
   * - ALB/ELB 用: 環境変数 CDK_DEPLOY_REGION または AWS_REGION で指定
   *   例: CDK_DEPLOY_REGION=ap-northeast-1 npm run deploy
   *
   * 重要: CloudFront で使用する証明書は必ず us-east-1 にデプロイしてください
   */
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT, // 現在の AWS アカウント ID
    region: process.env.CDK_DEPLOY_REGION || process.env.AWS_REGION || 'us-east-1', // デフォルトは us-east-1（CloudFront 用）
  },

  /**
   * SNS 通知の設定
   *
   * 証明書更新の成功/失敗通知を受け取るには、デプロイ後に手動で
   * AcmeToAcmNotifications トピックにメールアドレスをサブスクライブする
   *
   * サブスクリプション追加コマンド:
   * aws sns subscribe --topic-arn <TOPIC_ARN> --protocol email --notification-endpoint your-email@example.com
   */

  /**
   * 自動更新スケジュール式（EventBridge cron）
   *
   * デフォルト: 毎週日曜日 2:00 JST（UTC 土曜日 17:00）
   * EventBridge cron 構文を使用してカスタマイズ可能
   *
   * 例:
   * - 'cron(0 17 ? * SUN *)' - 毎週日曜日 2:00 JST
   * - 'cron(0 3 1 * ? *)' - 毎月 1 日 12:00 JST
   * - 'cron(0 0 ? * MON-FRI *)' - 毎平日 9:00 JST
   */
  // scheduleExpression: 'cron(0 17 ? * SUN *)',

  /**
   * 自動更新スケジュールの有効化/無効化
   *
   * false に設定すると EventBridge スケジュールが作成されず、
   * 手動実行のみになる（テスト環境などで有用）
   */
  // enableSchedule: true,

  /**
   * スタックの説明
   * CloudFormation コンソールで表示される
   */
  description: 'ACME to ACM certificate renewal system with Certbot on Lambda',

  /**
   * スタックタグ
   * AWS リソースの管理と請求の分類に使用
   */
  tags: {
    Project: 'AcmeToAcm', // プロジェクト名
    ManagedBy: 'CDK', // CDK による管理を示す
  },

  /**
   * リソース名のサフィックス（環境変数 STACK_SUFFIX から取得）
   * 複数スタックを同一アカウントにデプロイする場合に使用
   */
  stackNameSuffix: stackSuffix,
});
