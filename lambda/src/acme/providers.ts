import { AcmeProvider, AcmeProviderConfig } from '../types/domain-config';
import { JPRS_PROVIDER } from './jprs-provider';
import { LETSENCRYPT_PRODUCTION } from './letsencrypt-provider';

/**
 * Get ACME provider configuration by name
 */
export function getProviderConfig(provider: AcmeProvider, customServerUrl?: string): AcmeProviderConfig {
  switch (provider) {
    case 'jprs':
      return JPRS_PROVIDER;

    case 'letsencrypt':
      return LETSENCRYPT_PRODUCTION;

    case 'custom':
      if (!customServerUrl) {
        throw new Error('Custom ACME provider requires serverUrl to be specified');
      }
      return {
        name: 'custom',
        serverUrl: customServerUrl,
        eabRequired: false,
      };

    default:
      throw new Error(`Unknown ACME provider: ${provider}`);
  }
}

/**
 * Get ACME server URL for a provider
 */
export function getServerUrl(provider: AcmeProvider, customServerUrl?: string): string {
  const config = getProviderConfig(provider, customServerUrl);
  return config.serverUrl;
}

/**
 * Check if provider requires External Account Binding (EAB)
 */
export function requiresEab(provider: AcmeProvider): boolean {
  const config = getProviderConfig(provider);
  return config.eabRequired;
}
