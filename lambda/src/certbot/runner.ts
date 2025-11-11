import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  CertbotCertificatePaths,
  CertificateConfig,
  RegisterPayload,
  CertonlyPayload,
} from '../types/domain-config';
import { getServerUrl } from '../acme/providers';

/**
 * CertbotRunner handles executing Certbot commands
 */
export class CertbotRunner {
  private certbotDir: string;
  private configDir: string;
  private workDir: string;
  private logsDir: string;

  constructor(certbotDir = '/tmp/certbot') {
    this.certbotDir = certbotDir;
    this.configDir = path.join(certbotDir, 'config');
    this.workDir = path.join(certbotDir, 'work');
    this.logsDir = path.join(certbotDir, 'logs');
  }

  /**
   * Initialize Certbot directories
   */
  initialize(): void {
    console.log('Initializing Certbot directories...');

    for (const dir of [this.configDir, this.workDir, this.logsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    }
  }

  /**
   * Register ACME account with EAB (External Account Binding)
   * This is required for JPRS and other providers that use EAB
   */
  async registerAccount(payload: RegisterPayload): Promise<void> {
    console.log(`Registering ACME account for ${payload.email}`);
    console.log(`Server: ${payload.server}`);

    const args = [
      'certbot register',
      '--non-interactive',
      '--agree-tos',
      `-m ${payload.email}`,
      `--server ${payload.server}`,
      `--eab-kid ${payload.eabKid}`,
      `--eab-hmac-key ${payload.eabHmacKey}`,
      `--config-dir ${this.configDir}`,
      `--work-dir ${this.workDir}`,
      `--logs-dir ${this.logsDir}`,
    ];

    const command = args.join(' ');
    console.log('Executing: certbot register (EAB credentials hidden)');

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      console.log('Account registered successfully');
      console.log('Output:', output);
    } catch (error: any) {
      console.error('Account registration failed:', error.message);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      throw new Error(`Certbot register failed: ${error.message}`);
    }
  }

  /**
   * Obtain certificate using Certbot (for renew mode)
   */
  async obtainCertificate(config: CertificateConfig): Promise<CertbotCertificatePaths> {
    console.log(`Obtaining certificate for ${config.domains.join(', ')}`);

    const serverUrl = getServerUrl(config.acmeProvider, config.acmeServerUrl);

    // Build Certbot command
    const command = this.buildCertbotCommand({
      domains: config.domains,
      email: config.email,
      serverUrl,
      route53HostedZoneId: config.route53HostedZoneId,
      forceRenewal: !!config.acmCertificateArn,
      keyType: config.keyType,
      rsaKeySize: config.rsaKeySize,
    });

    console.log(`Executing: ${command}`);

    try {
      // Execute Certbot
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          AWS_DEFAULT_REGION: process.env.AWS_REGION || 'us-east-1',
        },
      });

      console.log('Certbot output:', output);

      // Get certificate paths
      const certPaths = this.getCertificatePaths(config.domains[0]);

      console.log('Certificate obtained successfully');
      console.log('Paths:', certPaths);

      return certPaths;
    } catch (error: any) {
      console.error('Certbot execution failed:', error.message);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      throw new Error(`Certbot failed: ${error.message}`);
    }
  }

  /**
   * Obtain certificate using Certbot (for certonly mode)
   */
  async obtainCertificateFromPayload(payload: CertonlyPayload): Promise<CertbotCertificatePaths> {
    console.log(`Obtaining certificate for ${payload.domains.join(', ')}`);
    console.log(`Server: ${payload.server}`);

    // Build Certbot command
    const command = this.buildCertbotCommand({
      domains: payload.domains,
      email: payload.email,
      serverUrl: payload.server,
      route53HostedZoneId: payload.route53HostedZoneId,
      forceRenewal: payload.forceRenewal || false,
      keyType: payload.keyType,
      rsaKeySize: payload.rsaKeySize,
    });

    console.log(`Executing: ${command}`);

    try {
      // Execute Certbot
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          AWS_DEFAULT_REGION: process.env.AWS_REGION || 'us-east-1',
        },
      });

      console.log('Certbot output:', output);

      // Get certificate paths
      const certPaths = this.getCertificatePaths(payload.domains[0]);

      console.log('Certificate obtained successfully');
      console.log('Paths:', certPaths);

      return certPaths;
    } catch (error: any) {
      console.error('Certbot execution failed:', error.message);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      throw new Error(`Certbot failed: ${error.message}`);
    }
  }

  /**
   * Build Certbot command
   */
  private buildCertbotCommand(params: {
    domains: string[];
    email: string;
    serverUrl: string;
    route53HostedZoneId: string;
    forceRenewal: boolean;
    keyType?: 'rsa' | 'ecdsa';
    rsaKeySize?: 2048 | 4096;
  }): string {
    const domainArgs = params.domains.map(d => `-d ${d}`).join(' ');
    const keyType = params.keyType || 'rsa';
    const rsaKeySize = params.rsaKeySize || 2048;

    const args = [
      'certbot certonly',
      '--non-interactive',
      '--agree-tos',
      `--email ${params.email}`,
      '--dns-route53',
      `--server ${params.serverUrl}`,
      `--config-dir ${this.configDir}`,
      `--work-dir ${this.workDir}`,
      `--logs-dir ${this.logsDir}`,
      domainArgs,
      '--preferred-challenges dns-01',
      `--key-type ${keyType}`,
    ];

    // Add RSA key size if using RSA
    if (keyType === 'rsa') {
      args.push(`--rsa-key-size ${rsaKeySize}`);
    }

    // Add force renewal if needed
    if (params.forceRenewal) {
      args.push('--force-renewal');
    }

    return args.join(' ');
  }

  /**
   * Get certificate file paths
   */
  private getCertificatePaths(primaryDomain: string): CertbotCertificatePaths {
    const liveDir = path.join(this.configDir, 'live', primaryDomain);

    if (!fs.existsSync(liveDir)) {
      throw new Error(`Certificate directory not found: ${liveDir}`);
    }

    const paths: CertbotCertificatePaths = {
      certPath: path.join(liveDir, 'cert.pem'),
      chainPath: path.join(liveDir, 'chain.pem'),
      fullChainPath: path.join(liveDir, 'fullchain.pem'),
      privateKeyPath: path.join(liveDir, 'privkey.pem'),
    };

    // Verify all files exist
    for (const [name, filePath] of Object.entries(paths)) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Certificate file not found: ${filePath} (${name})`);
      }
    }

    return paths;
  }

  /**
   * Clean up Certbot working directories
   */
  cleanup(): void {
    console.log('Cleaning up Certbot directories...');

    try {
      if (fs.existsSync(this.certbotDir)) {
        fs.rmSync(this.certbotDir, { recursive: true, force: true });
        console.log(`Removed directory: ${this.certbotDir}`);
      }
    } catch (error: any) {
      console.error('Failed to cleanup Certbot directories:', error.message);
      // Don't throw - cleanup failure shouldn't break the process
    }
  }

  /**
   * Get config directory path (for S3 sync)
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Get Certbot directory path
   */
  getCertbotDir(): string {
    return this.certbotDir;
  }
}
