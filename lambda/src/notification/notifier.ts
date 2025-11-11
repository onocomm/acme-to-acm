import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { RenewalResult } from '../types/domain-config';

/**
 * Notifier handles sending notifications via SNS
 */
export class Notifier {
  private snsClient: SNSClient;
  private topicArn: string;

  constructor(topicArn: string, region = 'us-east-1') {
    this.topicArn = topicArn;
    this.snsClient = new SNSClient({ region });
  }

  /**
   * Send summary notification for all certificate renewals
   */
  async sendRenewalSummary(results: RenewalResult[]): Promise<void> {
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => r.success === false && !r.skipped).length;
    const skippedCount = results.filter(r => r.skipped).length;

    const subject = this.buildSubject(successCount, failureCount, skippedCount);
    const message = this.buildMessage(results, successCount, failureCount, skippedCount);

    await this.publish(subject, message);
  }

  /**
   * Send success notification (for register and certonly modes)
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
   * Send error notification
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
   * Build notification subject
   */
  private buildSubject(successCount: number, failureCount: number, skippedCount: number): string {
    if (failureCount > 0) {
      return `[FAILURE] ACME to ACM - ${failureCount} certificate(s) failed to renew`;
    }

    if (successCount > 0) {
      return `[SUCCESS] ACME to ACM - ${successCount} certificate(s) renewed`;
    }

    return `[INFO] ACME to ACM - ${skippedCount} certificate(s) skipped`;
  }

  /**
   * Build notification message
   */
  private buildMessage(
    results: RenewalResult[],
    successCount: number,
    failureCount: number,
    skippedCount: number
  ): string {
    const lines: string[] = [
      'ACME to ACM Certificate Renewal Summary',
      '=' .repeat(60),
      '',
      `Total Processed: ${results.length}`,
      `  ✓ Success: ${successCount}`,
      `  ✗ Failed:  ${failureCount}`,
      `  ⊘ Skipped: ${skippedCount}`,
      '',
    ];

    // Success details
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

    // Failure details
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

    // Skipped details
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

    lines.push('');
    lines.push('Check CloudWatch Logs for detailed execution logs.');
    lines.push(`Timestamp: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /**
   * Publish message to SNS
   */
  private async publish(subject: string, message: string): Promise<void> {
    console.log(`Sending notification: ${subject}`);

    const command = new PublishCommand({
      TopicArn: this.topicArn,
      Subject: subject,
      Message: message,
    });

    try {
      await this.snsClient.send(command);
      console.log('Notification sent successfully');
    } catch (error) {
      console.error('Failed to send notification:', error);
      // Don't throw - notification failure shouldn't break the entire process
    }
  }
}
