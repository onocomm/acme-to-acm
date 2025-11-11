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
 * Props for CertificateLambda construct
 */
export interface CertificateLambdaProps {
  /**
   * S3 bucket for certificate storage
   */
  bucket: s3.IBucket;

  /**
   * SNS topic for notifications
   */
  snsTopic: sns.ITopic;

  /**
   * Domain configuration file key in S3
   * @default 'config/domains.json'
   */
  domainConfigKey?: string;

  /**
   * Schedule expression for automatic renewal (EventBridge cron)
   * @default 'cron(0 17 ? * SUN *)' - Weekly on Sunday at 2AM JST (17:00 UTC Saturday)
   */
  scheduleExpression?: string;

  /**
   * Enable automatic renewal schedule
   * @default true
   */
  enableSchedule?: boolean;
}

/**
 * Lambda function for certificate renewal
 */
export class CertificateLambda extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: CertificateLambdaProps) {
    super(scope, id);

    const domainConfigKey = props.domainConfigKey || 'config/domains.json';
    const scheduleExpression = props.scheduleExpression || 'cron(0 17 ? * SUN *)';
    const enableSchedule = props.enableSchedule !== false;

    // Create Lambda function from Docker image
    this.function = new lambda.DockerImageFunction(this, 'RenewalFunction', {
      functionName: 'AcmeToAcmCertificateRenewer',
      description: 'ACME certificate renewal and ACM import',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../lambda'),
        {
          file: 'Dockerfile',
          platform: Platform.LINUX_AMD64,
        }
      ),
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      architecture: lambda.Architecture.X86_64,
      environment: {
        CERTIFICATE_BUCKET: props.bucket.bucketName,
        SNS_TOPIC_ARN: props.snsTopic.topicArn,
        DOMAIN_CONFIG_KEY: domainConfigKey,
        CERTBOT_DIR: '/tmp/certbot',
      },
    });

    // Grant permissions
    this.grantPermissions(props);

    // Create EventBridge schedule if enabled
    if (enableSchedule) {
      this.createSchedule(scheduleExpression);
    }

    // Add CloudFormation outputs
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
   * Grant necessary permissions to the Lambda function
   */
  private grantPermissions(props: CertificateLambdaProps): void {
    // S3 permissions
    props.bucket.grantReadWrite(this.function);

    // SNS permissions
    props.snsTopic.grantPublish(this.function);

    // Route53 permissions for DNS validation
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'route53:ListHostedZones',
          'route53:GetChange',
        ],
        resources: ['*'],
      })
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'route53:ChangeResourceRecordSets',
          'route53:GetHostedZone',
          'route53:ListResourceRecordSets',
        ],
        resources: ['arn:aws:route53:::hostedzone/*'],
      })
    );

    // ACM permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'acm:ImportCertificate',
          'acm:DescribeCertificate',
          'acm:ListCertificates',
          'acm:AddTagsToCertificate',
        ],
        resources: ['*'],
      })
    );

    // Note: CloudWatch Logs permissions are automatically granted by Lambda
  }

  /**
   * Create EventBridge schedule for automatic renewal
   */
  private createSchedule(scheduleExpression: string): void {
    const rule = new events.Rule(this, 'WeeklyRenewalSchedule', {
      ruleName: 'AcmeToAcmWeeklyCheck',
      description: 'Weekly certificate renewal check',
      schedule: events.Schedule.expression(scheduleExpression),
    });

    rule.addTarget(
      new targets.LambdaFunction(this.function, {
        event: events.RuleTargetInput.fromObject({
          mode: 'renew',
        }),
      })
    );

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
