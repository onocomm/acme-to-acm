import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Props for CertificateStorage construct
 */
export interface CertificateStorageProps {
  /**
   * Bucket name suffix (will be prefixed with account ID)
   */
  bucketNameSuffix?: string;
}

/**
 * S3 bucket for certificate storage
 */
export class CertificateStorage extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: CertificateStorageProps) {
    super(scope, id);

    const account = cdk.Stack.of(this).account;
    const bucketName = `acme-to-acm-certificates-${account}${props?.bucketNameSuffix || ''}`;

    // Create S3 bucket for certificate storage
    this.bucket = new s3.Bucket(this, 'CertificateBucket', {
      bucketName: bucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'DeleteOldCertificates',
          enabled: true,
          prefix: 'certificates/',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(180),
        },
      ],
    });

    // Add CloudFormation output
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for certificate storage',
      exportName: 'AcmeToAcmBucketName',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucketArn,
      description: 'S3 bucket ARN',
      exportName: 'AcmeToAcmBucketArn',
    });
  }
}
