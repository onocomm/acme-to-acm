import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * Props for CertificateNotification construct
 */
export interface CertificateNotificationProps {
  /**
   * Placeholder for future configuration options
   */
}

/**
 * SNS topic for certificate renewal notifications
 */
export class CertificateNotification extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props?: CertificateNotificationProps) {
    super(scope, id);

    // Create SNS topic
    this.topic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'ACME to ACM Certificate Renewal Notifications',
      topicName: 'AcmeToAcmNotifications',
    });

    // Note: Email subscriptions should be added manually by administrators
    // Use AWS Console or CLI: aws sns subscribe --topic-arn <ARN> --protocol email --notification-endpoint <EMAIL>

    // Add CloudFormation outputs
    new cdk.CfnOutput(this, 'TopicArn', {
      value: this.topic.topicArn,
      description: 'SNS topic ARN for certificate notifications',
      exportName: 'AcmeToAcmTopicArn',
    });

    new cdk.CfnOutput(this, 'TopicName', {
      value: this.topic.topicName,
      description: 'SNS topic name',
      exportName: 'AcmeToAcmTopicName',
    });
  }
}
