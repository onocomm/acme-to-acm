#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AcmeToAcmStack } from '../lib/acme-to-acm-stack';

const app = new cdk.App();

new AcmeToAcmStack(app, 'AcmeToAcmStack', {
  /**
   * Deployment region - must be us-east-1 for CloudFront certificates
   */
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },

  /**
   * SNS notifications are available via the AcmeToAcmNotifications topic
   * Subscribe manually using AWS Console or CLI after deployment:
   * aws sns subscribe --topic-arn <TOPIC_ARN> --protocol email --notification-endpoint your-email@example.com
   */

  /**
   * Schedule expression for automatic renewal
   * Default: Weekly on Sunday at 2AM JST (Saturday 17:00 UTC)
   * Customize as needed using EventBridge cron syntax
   */
  // scheduleExpression: 'cron(0 17 ? * SUN *)',

  /**
   * Enable/disable automatic renewal schedule
   * Set to false to disable scheduled renewal (manual only)
   */
  // enableSchedule: true,

  /**
   * Stack description
   */
  description: 'ACME to ACM certificate renewal system with Certbot on Lambda',

  /**
   * Stack tags
   */
  tags: {
    Project: 'AcmeToAcm',
    ManagedBy: 'CDK',
  },
});
