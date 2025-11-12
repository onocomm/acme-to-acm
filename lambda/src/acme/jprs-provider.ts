/**
 * JPRS ACME プロバイダー設定
 *
 * JPRS（日本レジストリサービス）の ACME プロトコル設定。
 * .jp ドメインなどの日本語ドメイン証明書取得に使用。
 *
 * ドキュメント: https://jprs.jp/related-info/guide/058.html
 */

import { AcmeProviderConfig } from '../types/domain-config';

/**
 * JPRS ACME プロバイダー設定オブジェクト
 *
 * 注意: JPRS は EAB（External Account Binding）を要求するため、
 * アカウント登録時に一時的な EAB 認証情報が必要。
 */
export const JPRS_PROVIDER: AcmeProviderConfig = {
  name: 'jprs',
  serverUrl: 'https://acme.amecert.jprs.jp/DV/getDirector', // JPRS ACME サーバー URL
  eabRequired: false, // EAB は必須だが、ここでは false（register モードで処理）
};

/**
 * JPRS ACME サーバー URL を取得
 *
 * @returns JPRS ACME サーバー URL
 */
export function getJprsServerUrl(): string {
  return JPRS_PROVIDER.serverUrl;
}

/**
 * JPRS が EAB（External Account Binding）を必要とするかチェック
 *
 * @returns EAB が必要な場合は true
 */
export function jprsRequiresEab(): boolean {
  return JPRS_PROVIDER.eabRequired;
}
