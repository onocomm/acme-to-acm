import {
  ACMClient,
  ImportCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  AddTagsToCertificateCommand,
} from '@aws-sdk/client-acm';
import * as fs from 'fs';
import { CertbotCertificatePaths } from '../types/domain-config';

/**
 * Certificate information from ACM
 */
export interface CertificateInfo {
  arn: string;
  domainName: string;
  notAfter?: Date;
  status?: string;
}

/**
 * CertificateManager handles ACM operations
 */
export class CertificateManager {
  private acmClient: ACMClient;

  constructor(region = 'us-east-1') {
    this.acmClient = new ACMClient({ region });
  }

  /**
   * Import or reimport certificate to ACM
   */
  async importCertificate(
    certPaths: CertbotCertificatePaths,
    certificateId: string,
    existingArn?: string | null
  ): Promise<string> {
    console.log('Importing certificate to ACM...');

    // Read certificate files
    const certificate = fs.readFileSync(certPaths.fullChainPath);
    const privateKey = fs.readFileSync(certPaths.privateKeyPath);
    const certificateChain = fs.readFileSync(certPaths.chainPath);

    const command = new ImportCertificateCommand({
      Certificate: certificate,
      PrivateKey: privateKey,
      CertificateChain: certificateChain,
      CertificateArn: existingArn || undefined,
    });

    const response = await this.acmClient.send(command);

    if (!response.CertificateArn) {
      throw new Error('ACM did not return a certificate ARN');
    }

    console.log(`Certificate imported: ${response.CertificateArn}`);

    // Tag the certificate if it's new
    if (!existingArn) {
      await this.tagCertificate(response.CertificateArn, certificateId);
    }

    return response.CertificateArn;
  }

  /**
   * Get certificate information from ACM
   */
  async getCertificateInfo(arn: string): Promise<CertificateInfo | null> {
    try {
      const command = new DescribeCertificateCommand({
        CertificateArn: arn,
      });

      const response = await this.acmClient.send(command);

      if (!response.Certificate) {
        return null;
      }

      return {
        arn: arn,
        domainName: response.Certificate.DomainName || '',
        notAfter: response.Certificate.NotAfter,
        status: response.Certificate.Status,
      };
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        console.log(`Certificate not found: ${arn}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if certificate needs renewal
   */
  async needsRenewal(arn: string, daysBeforeExpiry: number): Promise<boolean> {
    const info = await this.getCertificateInfo(arn);

    if (!info || !info.notAfter) {
      console.log('Certificate info not available, renewal recommended');
      return true;
    }

    const now = new Date();
    const expiryDate = new Date(info.notAfter);
    const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    console.log(`Certificate expires in ${daysUntilExpiry} days (threshold: ${daysBeforeExpiry} days)`);

    return daysUntilExpiry <= daysBeforeExpiry;
  }

  /**
   * Tag certificate with metadata
   */
  private async tagCertificate(arn: string, certificateId: string): Promise<void> {
    console.log(`Tagging certificate ${arn}`);

    const command = new AddTagsToCertificateCommand({
      CertificateArn: arn,
      Tags: [
        {
          Key: 'ManagedBy',
          Value: 'acme-to-acm',
        },
        {
          Key: 'CertificateId',
          Value: certificateId,
        },
        {
          Key: 'LastRenewal',
          Value: new Date().toISOString(),
        },
      ],
    });

    await this.acmClient.send(command);
    console.log('Certificate tagged successfully');
  }

  /**
   * Find certificate by tags
   */
  async findCertificateByTag(certificateId: string): Promise<string | null> {
    console.log(`Looking for certificate with tag CertificateId=${certificateId}`);

    const listCommand = new ListCertificatesCommand({
      CertificateStatuses: ['ISSUED'],
    });

    const listResponse = await this.acmClient.send(listCommand);

    if (!listResponse.CertificateSummaryList) {
      return null;
    }

    // Note: ListCertificates doesn't return tags, so we'd need to describe each one
    // For now, we rely on the ARN being stored in the configuration
    // This is a future enhancement

    return null;
  }
}
