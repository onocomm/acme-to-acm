import { AcmeProviderConfig } from '../types/domain-config';

/**
 * JPRS ACME Provider Configuration
 *
 * JPRS (Japan Registry Services) provides ACME protocol support for
 * Japanese domain certificates.
 *
 * Documentation: https://jprs.jp/related-info/guide/058.html
 */
export const JPRS_PROVIDER: AcmeProviderConfig = {
  name: 'jprs',
  serverUrl: 'https://acme.jprs.jp/directory',
  eabRequired: false,
};

/**
 * Get JPRS ACME server URL
 */
export function getJprsServerUrl(): string {
  return JPRS_PROVIDER.serverUrl;
}

/**
 * Check if JPRS requires External Account Binding (EAB)
 */
export function jprsRequiresEab(): boolean {
  return JPRS_PROVIDER.eabRequired;
}
