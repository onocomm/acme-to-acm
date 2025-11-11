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
    const notification = new CertificateNotification(this, 'Notification');

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
