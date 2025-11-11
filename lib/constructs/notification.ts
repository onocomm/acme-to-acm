import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * Props for CertificateNotification construct
 */
export interface CertificateNotificationProps {
  /**
   * Email address to send notifications to (optional)
   * If provided, an email subscription will be created
   */
  email?: string;
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

    // Add email subscription if provided
    if (props?.email) {
      this.topic.addSubscription(
        new subscriptions.EmailSubscription(props.email)
      );

      new cdk.CfnOutput(this, 'EmailSubscription', {
        value: props.email,
        description: 'Email subscription for notifications (requires confirmation)',
      });
    }

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
