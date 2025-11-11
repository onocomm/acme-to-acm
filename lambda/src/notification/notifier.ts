/**
 * SNS 通知マネージャー
 *
 * 証明書更新処理の結果を SNS トピック経由でメール通知する。
 * 成功/失敗/スキップの詳細を含むサマリーレポートを生成。
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { RenewalResult } from '../types/domain-config';

/**
 * Notifier - SNS 通知を管理するクラス
 */
export class Notifier {
  private snsClient: SNSClient;
  private topicArn: string;

  /**
   * コンストラクタ
   * @param topicArn - SNS トピック ARN
   * @param region - AWS リージョン（デフォルト: us-east-1）
   */
  constructor(topicArn: string, region = 'us-east-1') {
    this.topicArn = topicArn;
    this.snsClient = new SNSClient({ region });
  }

  /**
   * 全証明書の更新結果サマリーを送信
   *
   * renew モードの処理完了後に呼び出され、全証明書の処理結果を集約して通知する。
   * 成功/失敗/スキップの件数と各証明書の詳細を含む。
   *
   * @param results - 全証明書の処理結果
   */
  async sendRenewalSummary(results: RenewalResult[]): Promise<void> {
    // 各カテゴリの件数を集計
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => r.success === false && !r.skipped).length;
    const skippedCount = results.filter(r => r.skipped).length;

    // 件名とメッセージ本文を構築
    const subject = this.buildSubject(successCount, failureCount, skippedCount);
    const message = this.buildMessage(results, successCount, failureCount, skippedCount);

    // SNS に送信
    await this.publish(subject, message);
  }

  /**
   * 成功通知を送信（register / certonly モード用）
   *
   * ACME アカウント登録や手動証明書取得が成功した際に呼び出される。
   *
   * @param message - 成功メッセージ
   */
  async sendSuccess(message: string): Promise<void> {
    const subject = '[SUCCESS] ACME to ACM - Operation Completed';
    const formattedMessage = [
      'ACME to ACM Operation Completed Successfully',
      '='.repeat(60),
      '',
      message,
      '',
      `Timestamp: ${new Date().toISOString()}`,
    ].join('\n');

    await this.publish(subject, formattedMessage);
  }

  /**
   * エラー通知を送信
   *
   * 致命的エラーが発生した際に呼び出され、エラー詳細とスタックトレースを含む通知を送信。
   *
   * @param error - Error オブジェクト
   * @param context - エラーが発生したコンテキスト（オプション）
   */
  async sendError(error: Error, context?: string): Promise<void> {
    const subject = 'ACME to ACM - Critical Error';
    const message = [
      'A critical error occurred during certificate renewal process.',
      '',
      `Context: ${context || 'Unknown'}`,
      '',
      'Error Details:',
      `  Message: ${error.message}`,
      `  Stack: ${error.stack || 'No stack trace available'}`,
      '',
      'Please check CloudWatch Logs for more details.',
    ].join('\n');

    await this.publish(subject, message);
  }

  /**
   * 通知件名を構築（private メソッド）
   *
   * 処理結果に応じて適切な件名を生成。
   * 失敗がある場合は [FAILURE]、成功がある場合は [SUCCESS]、すべてスキップの場合は [INFO]。
   *
   * @param successCount - 成功件数
   * @param failureCount - 失敗件数
   * @param skippedCount - スキップ件数
   * @returns 件名
   */
  private buildSubject(successCount: number, failureCount: number, skippedCount: number): string {
    // 失敗がある場合は最優先でアラート
    if (failureCount > 0) {
      return `[FAILURE] ACME to ACM - ${failureCount} certificate(s) failed to renew`;
    }

    // 成功がある場合は成功通知
    if (successCount > 0) {
      return `[SUCCESS] ACME to ACM - ${successCount} certificate(s) renewed`;
    }

    // すべてスキップの場合は情報通知
    return `[INFO] ACME to ACM - ${skippedCount} certificate(s) skipped`;
  }

  /**
   * 通知メッセージ本文を構築（private メソッド）
   *
   * 証明書更新結果の詳細レポートを生成。
   * 成功/失敗/スキップの各カテゴリごとに証明書の詳細を記載。
   *
   * @param results - 全証明書の処理結果
   * @param successCount - 成功件数
   * @param failureCount - 失敗件数
   * @param skippedCount - スキップ件数
   * @returns メッセージ本文
   */
  private buildMessage(
    results: RenewalResult[],
    successCount: number,
    failureCount: number,
    skippedCount: number
  ): string {
    // メッセージ本文の各行を配列に格納
    const lines: string[] = [
      'ACME to ACM Certificate Renewal Summary',
      '='.repeat(60),
      '',
      `Total Processed: ${results.length}`,
      `  ✓ Success: ${successCount}`,
      `  ✗ Failed:  ${failureCount}`,
      `  ⊘ Skipped: ${skippedCount}`,
      '',
    ];

    // 成功した証明書の詳細
    const successes = results.filter(r => r.success);
    if (successes.length > 0) {
      lines.push('Successfully Renewed Certificates:');
      lines.push('-'.repeat(60));

      for (const result of successes) {
        lines.push(`  • ${result.certificateId}`);
        lines.push(`    Domains: ${result.domains.join(', ')}`);
        lines.push(`    ACM ARN: ${result.acmCertificateArn || 'N/A'}`);
        if (result.expiryDate) {
          lines.push(`    Expiry Date: ${result.expiryDate.toISOString()}`);
        }
        lines.push('');
      }
    }

    // 失敗した証明書の詳細
    const failures = results.filter(r => r.success === false && !r.skipped);
    if (failures.length > 0) {
      lines.push('Failed Certificates:');
      lines.push('-'.repeat(60));

      for (const result of failures) {
        lines.push(`  • ${result.certificateId}`);
        lines.push(`    Domains: ${result.domains.join(', ')}`);
        lines.push(`    Error: ${result.error || 'Unknown error'}`);
        lines.push('');
      }
    }

    // スキップされた証明書の詳細
    const skipped = results.filter(r => r.skipped);
    if (skipped.length > 0) {
      lines.push('Skipped Certificates:');
      lines.push('-'.repeat(60));

      for (const result of skipped) {
        lines.push(`  • ${result.certificateId}`);
        lines.push(`    Domains: ${result.domains.join(', ')}`);
        lines.push(`    Reason: ${result.skipReason || 'Not yet due for renewal'}`);
        lines.push('');
      }
    }

    // フッター
    lines.push('');
    lines.push('Check CloudWatch Logs for detailed execution logs.');
    lines.push(`Timestamp: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /**
   * SNS にメッセージを送信（private メソッド）
   *
   * SNS Publish API を呼び出してメール通知を送信。
   * 送信失敗しても処理全体を中断させない（graceful degradation）。
   *
   * @param subject - 件名
   * @param message - メッセージ本文
   */
  private async publish(subject: string, message: string): Promise<void> {
    console.log(`Sending notification: ${subject}`);

    // SNS Publish コマンドを構築
    const command = new PublishCommand({
      TopicArn: this.topicArn,
      Subject: subject,
      Message: message,
    });

    try {
      // SNS に送信
      await this.snsClient.send(command);
      console.log('Notification sent successfully');
    } catch (error) {
      // 通知送信失敗はエラーログのみ（処理全体は中断させない）
      console.error('Failed to send notification:', error);
      // Don't throw - notification failure shouldn't break the entire process
    }
  }
}
