/**
 * ドメイン設定と証明書管理の型定義
 *
 * Lambda 関数のペイロード、domains.json の設定スキーマ、
 * ACME プロバイダー設定などの型定義を提供。
 */

/**
 * ACME プロバイダータイプ
 * - jprs: JPRS（日本レジストリサービス）
 * - letsencrypt: Let's Encrypt
 * - custom: カスタム ACME サーバー
 */
export type AcmeProvider = 'jprs' | 'letsencrypt' | 'custom';

/**
 * 証明書キータイプ
 * - rsa: RSA 鍵（2048 または 4096 ビット）
 * - ecdsa: 楕円曲線鍵
 */
export type KeyType = 'rsa' | 'ecdsa';

/**
 * Lambda 実行モード
 * - register: ACME アカウント登録
 * - certonly: 手動証明書取得
 * - renew: 自動更新
 */
export type LambdaMode = 'register' | 'certonly' | 'renew';

/**
 * 単一証明書の設定（domains.json の 1 エントリ）
 */
export interface CertificateConfig {
  /**
   * この証明書の一意識別子
   * 例: "example-com", "wildcard-example-com"
   */
  id: string;

  /**
   * 証明書に含めるドメインのリスト（ワイルドカード対応）
   * 例: ["example.com", "*.example.com"]
   */
  domains: string[];

  /**
   * ACME 登録用の連絡先メールアドレス
   */
  email: string;

  /**
   * 使用する ACME プロバイダー
   */
  acmeProvider: AcmeProvider;

  /**
   * カスタム ACME サーバー URL
   * acmeProvider が 'custom' の場合は必須
   */
  acmeServerUrl?: string;

  /**
   * DNS 検証用の Route53 ホストゾーン ID
   * Certbot の Route53 プラグインが DNS-01 チャレンジで使用
   */
  route53HostedZoneId: string;

  /**
   * 更新用の既存 ACM 証明書 ARN
   * 新規証明書の場合は null
   */
  acmCertificateArn: string | null;

  /**
   * 有効期限の何日前に証明書を更新するか
   * @default 30
   */
  renewDaysBeforeExpiry: number;

  /**
   * この証明書の自動更新を有効にするか
   * @default true
   */
  enabled: boolean;

  /**
   * 証明書のキータイプ
   * @default 'rsa'
   */
  keyType?: KeyType;

  /**
   * RSA キーサイズ（keyType が 'rsa' の場合のみ使用）
   * @default 2048
   */
  rsaKeySize?: 2048 | 4096;
}

/**
 * すべての証明書に適用されるデフォルト値
 * domains.json の defaults セクションで使用
 */
export interface ConfigDefaults {
  /** デフォルトメールアドレス */
  email?: string;
  /** デフォルト ACME プロバイダー */
  acmeProvider?: AcmeProvider;
  /** デフォルト更新日数 */
  renewDaysBeforeExpiry?: number;
}

/**
 * domains.json のルート設定構造
 */
export interface DomainConfiguration {
  /**
   * 設定ファイルのバージョン
   * 将来の互換性のため
   */
  version: string;

  /**
   * すべての証明書に適用されるデフォルト値
   */
  defaults?: ConfigDefaults;

  /**
   * 証明書設定のリスト
   */
  certificates: CertificateConfig[];
}

/**
 * ACME プロバイダー設定
 */
export interface AcmeProviderConfig {
  /** プロバイダー名 */
  name: string;
  /** ACME サーバー URL */
  serverUrl: string;
  /** EAB（External Account Binding）が必要かどうか */
  eabRequired: boolean;
}

/**
 * 証明書更新結果
 * renew モードで各証明書の処理結果を格納
 */
export interface RenewalResult {
  /** 証明書 ID */
  certificateId: string;
  /** ドメインリスト */
  domains: string[];
  /** 処理が成功したかどうか */
  success: boolean;
  /** ACM 証明書 ARN（成功時） */
  acmCertificateArn?: string;
  /** 証明書の有効期限（成功時） */
  expiryDate?: Date;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** スキップされたかどうか */
  skipped?: boolean;
  /** スキップ理由 */
  skipReason?: string;
}

/**
 * Certbot が生成した証明書ファイルのパス
 * Certbot の live ディレクトリ配下のファイルパス
 */
export interface CertbotCertificatePaths {
  /** 証明書ファイル（cert.pem） */
  certPath: string;
  /** 中間証明書チェーン（chain.pem） */
  chainPath: string;
  /** 証明書 + チェーン（fullchain.pem） */
  fullChainPath: string;
  /** 秘密鍵（privkey.pem） */
  privateKeyPath: string;
}

/**
 * register モードのペイロード
 * EAB を使用した ACME アカウント登録
 */
export interface RegisterPayload {
  mode: 'register';
  /** 連絡先メールアドレス */
  email: string;
  /** ACME サーバー URL */
  server: string;
  /** External Account Binding Key ID（JPRS から一時的に発行） */
  eabKid: string;
  /** External Account Binding HMAC Key（JPRS から一時的に発行） */
  eabHmacKey: string;
}

/**
 * certonly モードのペイロード
 * 手動での証明書取得
 */
export interface CertonlyPayload {
  mode: 'certonly';
  /** 証明書に含めるドメイン */
  domains: string[];
  /** 連絡先メールアドレス */
  email: string;
  /** ACME サーバー URL */
  server: string;
  /** DNS 検証用の Route53 ホストゾーン ID */
  route53HostedZoneId: string;
  /** 再インポート用の既存 ACM 証明書 ARN（新規の場合は null） */
  acmCertificateArn?: string | null;
  /** 証明書のキータイプ @default 'rsa' */
  keyType?: KeyType;
  /** RSA キーサイズ @default 2048 */
  rsaKeySize?: 2048 | 4096;
  /** 有効期限前でも強制的に更新するか */
  forceRenewal?: boolean;
}

/**
 * renew モードのペイロード
 * domains.json に基づく自動更新
 */
export interface RenewPayload {
  mode: 'renew';
  /** 更新対象の証明書 ID リスト（未指定の場合は有効なすべての証明書） */
  certificateIds?: string[];
  /** ドライランモード（実際の変更は行わない） */
  dryRun?: boolean;
}

/**
 * Lambda イベント入力
 * 全モードのペイロードの Union 型
 */
export type LambdaEvent = RegisterPayload | CertonlyPayload | RenewPayload;

/**
 * Lambda レスポンス
 * すべてのモードで共通のレスポンス形式
 */
export interface LambdaResponse {
  /** HTTP ステータスコード（200: 成功, 500: エラー） */
  statusCode: number;
  /** レスポンスボディ */
  body: {
    /** メッセージ */
    message: string;
    /** 証明書処理結果のリスト */
    results: RenewalResult[];
    /** 処理した証明書の総数 */
    totalProcessed: number;
    /** 成功した証明書の数 */
    totalSuccess: number;
    /** 失敗した証明書の数 */
    totalFailed: number;
    /** スキップされた証明書の数 */
    totalSkipped: number;
  };
}
