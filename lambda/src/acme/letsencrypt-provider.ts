import { AcmeProviderConfig } from '../types/domain-config';

/**
 * Let's Encrypt ACME Provider Configuration
 *
 * Let's Encrypt is a free, automated, and open Certificate Authority.
 *
 * Documentation: https://letsencrypt.org/docs/
 */

/**
 * Production Let's Encrypt server
 * Use this for real certificates with browser trust
 */
export const LETSENCRYPT_PRODUCTION: AcmeProviderConfig = {
  name: 'letsencrypt',
  serverUrl: 'https://acme-v02.api.letsencrypt.org/directory',
  eabRequired: false,
};

/**
 * Staging Let's Encrypt server
 * Use this for testing to avoid rate limits
 */
export const LETSENCRYPT_STAGING: AcmeProviderConfig = {
  name: 'letsencrypt-staging',
  serverUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  eabRequired: false,
};

/**
 * Get Let's Encrypt production server URL
 */
export function getLetsEncryptServerUrl(): string {
  return LETSENCRYPT_PRODUCTION.serverUrl;
}

/**
 * Get Let's Encrypt staging server URL (for testing)
 */
export function getLetsEncryptStagingServerUrl(): string {
  return LETSENCRYPT_STAGING.serverUrl;
}

/**
 * Check if Let's Encrypt requires External Account Binding (EAB)
 */
export function letsEncryptRequiresEab(): boolean {
  return LETSENCRYPT_PRODUCTION.eabRequired;
}
