/**
 * ACME プロバイダー設定管理
 *
 * JPRS、Let's Encrypt、カスタムサーバーなどの ACME プロバイダー設定を管理。
 * プロバイダー名から設定オブジェクトを取得するヘルパー関数を提供。
 */

import { AcmeProvider, AcmeProviderConfig } from '../types/domain-config';
import { JPRS_PROVIDER } from './jprs-provider';
import { LETSENCRYPT_PRODUCTION } from './letsencrypt-provider';

/**
 * プロバイダー名から ACME プロバイダー設定を取得
 *
 * @param provider - プロバイダー名（'jprs', 'letsencrypt', 'custom'）
 * @param customServerUrl - カスタムプロバイダーの場合のサーバー URL
 * @returns ACME プロバイダー設定
 * @throws 未知のプロバイダーまたはカスタムプロバイダーで URL が未指定の場合にエラーをスロー
 */
export function getProviderConfig(provider: AcmeProvider, customServerUrl?: string): AcmeProviderConfig {
  switch (provider) {
    case 'jprs':
      // JPRS（日本レジストリサービス）設定を返却
      return JPRS_PROVIDER;

    case 'letsencrypt':
      // Let's Encrypt 本番環境設定を返却
      return LETSENCRYPT_PRODUCTION;

    case 'custom':
      // カスタム ACME サーバーの場合は URL が必須
      if (!customServerUrl) {
        throw new Error('Custom ACME provider requires serverUrl to be specified');
      }
      return {
        name: 'custom',
        serverUrl: customServerUrl,
        eabRequired: false, // カスタムサーバーはデフォルトで EAB 不要
      };

    default:
      // 未知のプロバイダー
      throw new Error(`Unknown ACME provider: ${provider}`);
  }
}

/**
 * プロバイダーの ACME サーバー URL を取得
 *
 * @param provider - プロバイダー名
 * @param customServerUrl - カスタムプロバイダーの場合のサーバー URL
 * @returns ACME サーバー URL
 */
export function getServerUrl(provider: AcmeProvider, customServerUrl?: string): string {
  const config = getProviderConfig(provider, customServerUrl);
  return config.serverUrl;
}

/**
 * プロバイダーが EAB（External Account Binding）を必要とするかチェック
 *
 * JPRS などの一部のプロバイダーは、アカウント登録時に EAB 認証情報が必要。
 *
 * @param provider - プロバイダー名
 * @returns EAB が必要な場合は true
 */
export function requiresEab(provider: AcmeProvider): boolean {
  const config = getProviderConfig(provider);
  return config.eabRequired;
}
