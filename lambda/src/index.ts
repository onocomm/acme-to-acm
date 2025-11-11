import { Handler } from 'aws-lambda';
import {
  DomainConfiguration,
  CertificateConfig,
  LambdaEvent,
  LambdaResponse,
  RenewalResult,
  RegisterPayload,
  CertonlyPayload,
  RenewPayload,
} from './types/domain-config';
import { S3Manager } from './storage/s3-manager';
import { Notifier } from './notification/notifier';
import { CertbotRunner } from './certbot/runner';
import { CertificateManager } from './acm/certificate-manager';

/**
 * Lambda handler for ACME certificate management (3 modes: register, certonly, renew)
 */
export const handler: Handler<LambdaEvent, LambdaResponse> = async (event) => {
  console.log('Starting ACME to ACM certificate management');
  console.log('Event:', JSON.stringify(event, null, 2));

  const mode = event.mode;

  if (!mode) {
    throw new Error('Mode is required in event payload (register, certonly, or renew)');
  }

  // Route to appropriate mode handler
  switch (mode) {
    case 'register':
      return await handleRegisterMode(event as RegisterPayload);
    case 'certonly':
      return await handleCertonlyMode(event as CertonlyPayload);
    case 'renew':
      return await handleRenewMode(event as RenewPayload);
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
};

/**
 * Handle register mode: ACME account registration with EAB
 */
async function handleRegisterMode(event: RegisterPayload): Promise<LambdaResponse> {
  console.log('=== REGISTER MODE ===');
  console.log(`Email: ${event.email}`);
  console.log(`Server: ${event.server}`);

  const bucketName = process.env.CERTIFICATE_BUCKET;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;

  if (!bucketName || !snsTopicArn) {
    throw new Error('Required environment variables are missing');
  }

  const s3Manager = new S3Manager(bucketName);
  const notifier = new Notifier(snsTopicArn);
  const certbotRunner = new CertbotRunner();

  try {
    // Initialize Certbot directories
    certbotRunner.initialize();

    // Sync existing Certbot config from S3 (if exists)
    await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());

    // Register ACME account with EAB
    console.log('Registering ACME account...');
    await certbotRunner.registerAccount(event);

    // Sync Certbot config back to S3 (save account info)
    await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');

    console.log('Account registration completed successfully');

    // Send success notification
    await notifier.sendSuccess(
      `ACME account registered successfully for ${event.email} on ${event.server}`
    );

    return {
      statusCode: 200,
      body: {
        message: 'ACME account registered successfully',
        results: [],
        totalProcessed: 0,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 0,
      },
    };
  } catch (error: any) {
    console.error('Account registration failed:', error);

    // Send error notification
    await notifier.sendError(error, 'ACME account registration');

    return {
      statusCode: 500,
      body: {
        message: `Registration failed: ${error.message}`,
        results: [],
        totalProcessed: 0,
        totalSuccess: 0,
        totalFailed: 1,
        totalSkipped: 0,
      },
    };
  } finally {
    // Cleanup
    certbotRunner.cleanup();
  }
}

/**
 * Handle certonly mode: Manual certificate acquisition from payload
 */
async function handleCertonlyMode(event: CertonlyPayload): Promise<LambdaResponse> {
  console.log('=== CERTONLY MODE ===');
  console.log(`Domains: ${event.domains.join(', ')}`);
  console.log(`Email: ${event.email}`);
  console.log(`Server: ${event.server}`);

  const bucketName = process.env.CERTIFICATE_BUCKET;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;

  if (!bucketName || !snsTopicArn) {
    throw new Error('Required environment variables are missing');
  }

  const s3Manager = new S3Manager(bucketName);
  const notifier = new Notifier(snsTopicArn);
  const certbotRunner = new CertbotRunner();
  const certificateManager = new CertificateManager();

  try {
    // Initialize Certbot directories
    certbotRunner.initialize();

    // Sync existing Certbot config from S3 (requires registered account)
    await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());

    // Obtain certificate via Certbot
    console.log('Obtaining certificate from ACME server...');
    const certPaths = await certbotRunner.obtainCertificateFromPayload(event);

    // Backup certificate files to S3
    const certId = `manual-${event.domains[0].replace(/[^a-zA-Z0-9]/g, '-')}`;
    console.log('Backing up certificate to S3...');
    await s3Manager.saveCertificateBackup(
      certId,
      certPaths.certPath,
      certPaths.privateKeyPath,
      certPaths.chainPath,
      certPaths.fullChainPath
    );

    // Import certificate to ACM
    console.log('Importing certificate to ACM...');
    const acmArn = await certificateManager.importCertificate(
      certPaths,
      certId,
      event.acmCertificateArn || null
    );

    // Get certificate info
    const certInfo = await certificateManager.getCertificateInfo(acmArn);

    console.log('Certificate obtained and imported successfully');
    console.log(`ACM ARN: ${acmArn}`);

    // Sync Certbot config back to S3
    await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');

    // Send success notification
    await notifier.sendSuccess(
      `Certificate obtained successfully for ${event.domains.join(', ')}\nACM ARN: ${acmArn}`
    );

    const result: RenewalResult = {
      certificateId: certId,
      domains: event.domains,
      success: true,
      acmCertificateArn: acmArn,
      expiryDate: certInfo?.notAfter,
    };

    return {
      statusCode: 200,
      body: {
        message: 'Certificate obtained and imported successfully',
        results: [result],
        totalProcessed: 1,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 0,
      },
    };
  } catch (error: any) {
    console.error('Certificate acquisition failed:', error);

    // Send error notification
    await notifier.sendError(error, 'Certificate acquisition');

    const result: RenewalResult = {
      certificateId: `manual-${event.domains[0].replace(/[^a-zA-Z0-9]/g, '-')}`,
      domains: event.domains,
      success: false,
      error: error.message,
    };

    return {
      statusCode: 500,
      body: {
        message: `Certificate acquisition failed: ${error.message}`,
        results: [result],
        totalProcessed: 1,
        totalSuccess: 0,
        totalFailed: 1,
        totalSkipped: 0,
      },
    };
  } finally {
    // Cleanup
    certbotRunner.cleanup();
  }
}

/**
 * Handle renew mode: Automatic renewal based on domains.json
 */
async function handleRenewMode(event: RenewPayload): Promise<LambdaResponse> {
  console.log('=== RENEW MODE ===');
  console.log(`Dry run: ${event.dryRun || false}`);

  const bucketName = process.env.CERTIFICATE_BUCKET;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;
  const domainConfigKey = process.env.DOMAIN_CONFIG_KEY || 'config/domains.json';

  if (!bucketName || !snsTopicArn) {
    throw new Error('Required environment variables are missing');
  }

  // Initialize managers
  const s3Manager = new S3Manager(bucketName);
  const notifier = new Notifier(snsTopicArn);
  const certbotRunner = new CertbotRunner();
  const certificateManager = new CertificateManager();

  const results: RenewalResult[] = [];

  try {
    // Initialize Certbot directories
    certbotRunner.initialize();

    // Download domain configuration
    console.log('Downloading domain configuration...');
    const configJson = await s3Manager.downloadConfig(domainConfigKey);
    const config: DomainConfiguration = JSON.parse(configJson);

    console.log(`Loaded configuration version ${config.version} with ${config.certificates.length} certificates`);

    // Sync existing Certbot config from S3 (if exists)
    await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());

    // Process each certificate
    for (const certConfig of config.certificates) {
      // Skip if not enabled
      if (!certConfig.enabled) {
        console.log(`Skipping disabled certificate: ${certConfig.id}`);
        results.push({
          certificateId: certConfig.id,
          domains: certConfig.domains,
          success: false,
          skipped: true,
          skipReason: 'Certificate is disabled in configuration',
        });
        continue;
      }

      // Filter by certificate IDs if specified in event
      if (event.certificateIds && !event.certificateIds.includes(certConfig.id)) {
        console.log(`Skipping certificate not in event filter: ${certConfig.id}`);
        continue;
      }

      // Process certificate
      const result = await processCertificate(
        certConfig,
        s3Manager,
        certbotRunner,
        certificateManager,
        event.dryRun || false
      );

      results.push(result);
    }

    // Sync Certbot config back to S3
    await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');

    // Send summary notification
    await notifier.sendRenewalSummary(results);

    // Calculate summary
    const summary = {
      totalProcessed: results.length,
      totalSuccess: results.filter(r => r.success).length,
      totalFailed: results.filter(r => r.success === false && !r.skipped).length,
      totalSkipped: results.filter(r => r.skipped).length,
    };

    console.log('Certificate renewal completed');
    console.log('Summary:', summary);

    return {
      statusCode: 200,
      body: {
        message: 'Certificate renewal process completed',
        results,
        ...summary,
      },
    };
  } catch (error: any) {
    console.error('Critical error:', error);

    // Send error notification
    await notifier.sendError(error, 'Certificate renewal process');

    return {
      statusCode: 500,
      body: {
        message: `Error: ${error.message}`,
        results,
        totalProcessed: results.length,
        totalSuccess: results.filter(r => r.success).length,
        totalFailed: results.filter(r => !r.success && !r.skipped).length,
        totalSkipped: results.filter(r => r.skipped).length,
      },
    };
  } finally {
    // Cleanup
    certbotRunner.cleanup();
  }
}

/**
 * Process a single certificate
 */
async function processCertificate(
  config: CertificateConfig,
  s3Manager: S3Manager,
  certbotRunner: CertbotRunner,
  certificateManager: CertificateManager,
  dryRun: boolean
): Promise<RenewalResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing certificate: ${config.id}`);
  console.log(`Domains: ${config.domains.join(', ')}`);
  console.log(`Provider: ${config.acmeProvider}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // Check if renewal is needed
    if (config.acmCertificateArn) {
      const needsRenewal = await certificateManager.needsRenewal(
        config.acmCertificateArn,
        config.renewDaysBeforeExpiry
      );

      if (!needsRenewal) {
        console.log('Certificate does not need renewal yet');
        return {
          certificateId: config.id,
          domains: config.domains,
          success: false,
          skipped: true,
          skipReason: 'Certificate is still valid and not due for renewal',
          acmCertificateArn: config.acmCertificateArn,
        };
      }
    }

    if (dryRun) {
      console.log('DRY RUN: Skipping actual certificate obtainment');
      return {
        certificateId: config.id,
        domains: config.domains,
        success: true,
        skipped: true,
        skipReason: 'Dry run mode - no actual changes made',
      };
    }

    // Obtain certificate via Certbot
    console.log('Obtaining certificate from ACME server...');
    const certPaths = await certbotRunner.obtainCertificate(config);

    // Backup certificate files to S3
    console.log('Backing up certificate to S3...');
    await s3Manager.saveCertificateBackup(
      config.id,
      certPaths.certPath,
      certPaths.privateKeyPath,
      certPaths.chainPath,
      certPaths.fullChainPath
    );

    // Import certificate to ACM
    console.log('Importing certificate to ACM...');
    const acmArn = await certificateManager.importCertificate(
      certPaths,
      config.id,
      config.acmCertificateArn
    );

    // Get certificate info
    const certInfo = await certificateManager.getCertificateInfo(acmArn);

    console.log(`Certificate ${config.id} processed successfully`);
    console.log(`ACM ARN: ${acmArn}`);

    return {
      certificateId: config.id,
      domains: config.domains,
      success: true,
      acmCertificateArn: acmArn,
      expiryDate: certInfo?.notAfter,
    };
  } catch (error: any) {
    console.error(`Failed to process certificate ${config.id}:`, error);

    return {
      certificateId: config.id,
      domains: config.domains,
      success: false,
      error: error.message,
    };
  }
}
