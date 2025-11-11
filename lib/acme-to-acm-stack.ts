import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CertificateStorage } from './constructs/storage';
import { CertificateNotification } from './constructs/notification';
import { CertificateLambda } from './constructs/certificate-lambda';

/**
 * Props for AcmeToAcmStack
 */
export interface AcmeToAcmStackProps extends cdk.StackProps {
  /**
   * Email address for SNS notifications (optional)
   */
  notificationEmail?: string;

  /**
   * Domain configuration file key in S3
   * @default 'config/domains.json'
   */
  domainConfigKey?: string;

  /**
   * Schedule expression for automatic renewal
   * @default 'cron(0 17 ? * SUN *)' - Weekly on Sunday at 2AM JST
   */
  scheduleExpression?: string;

  /**
   * Enable automatic renewal schedule
   * @default true
   */
  enableSchedule?: boolean;
}

/**
 * Main CDK stack for ACME to ACM certificate renewal system
 */
export class AcmeToAcmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: AcmeToAcmStackProps) {
    super(scope, id, props);

    // Create S3 bucket for certificate storage
    const storage = new CertificateStorage(this, 'Storage');

    // Create SNS topic for notifications
    const notification = new CertificateNotification(this, 'Notification', {
      email: props?.notificationEmail,
    });

    // Create Lambda function for certificate renewal
    const certificateLambda = new CertificateLambda(this, 'CertificateLambda', {
      bucket: storage.bucket,
      snsTopic: notification.topic,
      domainConfigKey: props?.domainConfigKey,
      scheduleExpression: props?.scheduleExpression,
      enableSchedule: props?.enableSchedule,
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'StackName', {
      value: this.stackName,
      description: 'Stack name',
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'AWS Region',
    });

    new cdk.CfnOutput(this, 'InstructionsMessage', {
      value: [
        'Next steps:',
        `1. Upload your domain configuration to s3://${storage.bucket.bucketName}/config/domains.json`,
        `2. If you provided an email, confirm the SNS subscription sent to ${props?.notificationEmail || 'your email'}`,
        `3. Test the Lambda function manually before the first scheduled run`,
        `4. Monitor CloudWatch Logs for execution details`,
      ].join('\n'),
      description: 'Post-deployment instructions',
    });
  }
}
