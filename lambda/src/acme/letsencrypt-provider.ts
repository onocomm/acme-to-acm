/**
 * Let's Encrypt ACME プロバイダー設定
 *
 * Let's Encrypt は無料、自動化された、オープンな認証局（CA）。
 * ブラウザで信頼される SSL/TLS 証明書を無料で取得できる。
 *
 * ドキュメント: https://letsencrypt.org/docs/
 */

import { AcmeProviderConfig } from '../types/domain-config';

/**
 * Let's Encrypt 本番環境サーバー設定
 *
 * ブラウザで信頼される本番用証明書を取得する際に使用。
 * レート制限があるため、テスト時は LETSENCRYPT_STAGING を使用推奨。
 */
export const LETSENCRYPT_PRODUCTION: AcmeProviderConfig = {
  name: 'letsencrypt',
  serverUrl: 'https://acme-v02.api.letsencrypt.org/directory', // 本番環境 URL
  eabRequired: false, // Let's Encrypt は EAB 不要
};

/**
 * Let's Encrypt ステージング環境サーバー設定
 *
 * テスト用の証明書を取得する際に使用。
 * 本番環境のレート制限を回避しつつ、動作確認ができる。
 * ステージング証明書はブラウザで信頼されない。
 */
export const LETSENCRYPT_STAGING: AcmeProviderConfig = {
  name: 'letsencrypt-staging',
  serverUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory', // ステージング環境 URL
  eabRequired: false, // Let's Encrypt は EAB 不要
};

/**
 * Let's Encrypt 本番環境サーバー URL を取得
 *
 * @returns Let's Encrypt 本番環境 URL
 */
export function getLetsEncryptServerUrl(): string {
  return LETSENCRYPT_PRODUCTION.serverUrl;
}

/**
 * Let's Encrypt ステージング環境サーバー URL を取得（テスト用）
 *
 * @returns Let's Encrypt ステージング環境 URL
 */
export function getLetsEncryptStagingServerUrl(): string {
  return LETSENCRYPT_STAGING.serverUrl;
}

/**
 * Let's Encrypt が EAB（External Account Binding）を必要とするかチェック
 *
 * @returns Let's Encrypt は EAB 不要のため false
 */
export function letsEncryptRequiresEab(): boolean {
  return LETSENCRYPT_PRODUCTION.eabRequired;
}
