/**
 * Type definitions for domain configuration and certificate management
 */

/**
 * ACME provider type
 */
export type AcmeProvider = 'jprs' | 'letsencrypt' | 'custom';

/**
 * Certificate key type
 */
export type KeyType = 'rsa' | 'ecdsa';

/**
 * Lambda execution mode
 */
export type LambdaMode = 'register' | 'certonly' | 'renew';

/**
 * Single certificate configuration
 */
export interface CertificateConfig {
  /**
   * Unique identifier for this certificate
   */
  id: string;

  /**
   * List of domains to include in the certificate (supports wildcards)
   */
  domains: string[];

  /**
   * Contact email address for ACME registration
   */
  email: string;

  /**
   * ACME provider to use
   */
  acmeProvider: AcmeProvider;

  /**
   * Custom ACME server URL (required if acmeProvider is 'custom')
   */
  acmeServerUrl?: string;

  /**
   * Route53 Hosted Zone ID for DNS validation
   */
  route53HostedZoneId: string;

  /**
   * Existing ACM certificate ARN for renewal (null for new certificates)
   */
  acmCertificateArn: string | null;

  /**
   * Number of days before expiry to renew the certificate
   * @default 30
   */
  renewDaysBeforeExpiry: number;

  /**
   * Whether this certificate is enabled for renewal
   * @default true
   */
  enabled: boolean;

  /**
   * Certificate key type
   * @default 'rsa'
   */
  keyType?: KeyType;

  /**
   * RSA key size (only used when keyType is 'rsa')
   * @default 2048
   */
  rsaKeySize?: 2048 | 4096;
}

/**
 * Default values applied to all certificates
 */
export interface ConfigDefaults {
  email?: string;
  acmeProvider?: AcmeProvider;
  renewDaysBeforeExpiry?: number;
}

/**
 * Root configuration structure
 */
export interface DomainConfiguration {
  /**
   * Configuration file version
   */
  version: string;

  /**
   * Default values applied to all certificates
   */
  defaults?: ConfigDefaults;

  /**
   * List of certificate configurations
   */
  certificates: CertificateConfig[];
}

/**
 * ACME provider configuration
 */
export interface AcmeProviderConfig {
  name: string;
  serverUrl: string;
  eabRequired: boolean;
}

/**
 * Certificate renewal result
 */
export interface RenewalResult {
  certificateId: string;
  domains: string[];
  success: boolean;
  acmCertificateArn?: string;
  expiryDate?: Date;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Certificate file paths from Certbot
 */
export interface CertbotCertificatePaths {
  certPath: string;
  chainPath: string;
  fullChainPath: string;
  privateKeyPath: string;
}

/**
 * Register mode payload (ACME account registration with EAB)
 */
export interface RegisterPayload {
  mode: 'register';
  /** Contact email address */
  email: string;
  /** ACME server URL */
  server: string;
  /** External Account Binding Key ID (temporary, from JPRS) */
  eabKid: string;
  /** External Account Binding HMAC Key (temporary, from JPRS) */
  eabHmacKey: string;
}

/**
 * Certonly mode payload (Manual certificate acquisition)
 */
export interface CertonlyPayload {
  mode: 'certonly';
  /** Domains to include in the certificate */
  domains: string[];
  /** Contact email address */
  email: string;
  /** ACME server URL */
  server: string;
  /** Route53 Hosted Zone ID for DNS validation */
  route53HostedZoneId: string;
  /** Existing ACM certificate ARN for re-import (null for new) */
  acmCertificateArn?: string | null;
  /** Certificate key type @default 'rsa' */
  keyType?: KeyType;
  /** RSA key size @default 2048 */
  rsaKeySize?: 2048 | 4096;
  /** Force renewal even if certificate is not yet expiring */
  forceRenewal?: boolean;
}

/**
 * Renew mode payload (Automatic renewal based on domains.json)
 */
export interface RenewPayload {
  mode: 'renew';
  /** Certificate IDs to renew (if not specified, all enabled certificates) */
  certificateIds?: string[];
  /** Dry run mode (no actual changes) */
  dryRun?: boolean;
}

/**
 * Lambda event input (union of all modes)
 */
export type LambdaEvent = RegisterPayload | CertonlyPayload | RenewPayload;

/**
 * Lambda response
 */
export interface LambdaResponse {
  statusCode: number;
  body: {
    message: string;
    results: RenewalResult[];
    totalProcessed: number;
    totalSuccess: number;
    totalFailed: number;
    totalSkipped: number;
  };
}
