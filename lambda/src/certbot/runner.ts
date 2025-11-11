/**
 * Certbot コマンド実行マネージャー
 *
 * Certbot CLI を実行して ACME サーバーから SSL/TLS 証明書を取得するためのラッパークラス。
 * Lambda の /tmp ディレクトリに作業ディレクトリを作成し、証明書取得、アカウント登録、
 * ファイルパス解決などの機能を提供する。
 */

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
 * CertbotRunner - Certbot コマンドの実行を管理するクラス
 */
export class CertbotRunner {
  private certbotDir: string; // Certbot のルートディレクトリ（デフォルト: /tmp/certbot）
  private configDir: string; // Certbot 設定ディレクトリ（アカウント情報、証明書など）
  private workDir: string; // Certbot 作業ディレクトリ（一時ファイル）
  private logsDir: string; // Certbot ログディレクトリ

  /**
   * コンストラクタ
   * @param certbotDir - Certbot のルートディレクトリ（デフォルト: /tmp/certbot）
   */
  constructor(certbotDir = '/tmp/certbot') {
    this.certbotDir = certbotDir;
    this.configDir = path.join(certbotDir, 'config');
    this.workDir = path.join(certbotDir, 'work');
    this.logsDir = path.join(certbotDir, 'logs');
  }

  /**
   * Certbot の作業ディレクトリを初期化
   *
   * Lambda の /tmp 内に以下のディレクトリを作成:
   * - config: ACME アカウント情報と証明書を保存
   * - work: Certbot の一時作業ファイル
   * - logs: Certbot の実行ログ
   */
  initialize(): void {
    console.log('Initializing Certbot directories...');

    // 必要なディレクトリを作成（存在しない場合のみ）
    for (const dir of [this.configDir, this.workDir, this.logsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    }
  }

  /**
   * EAB（External Account Binding）を使用して ACME アカウントを登録
   *
   * JPRS などの EAB が必要な ACME プロバイダーでアカウントを登録する。
   * 登録情報（アカウント鍵など）は configDir に保存され、以降の証明書取得で使用される。
   * EAB 認証情報（eabKid, eabHmacKey）は一時的なもので、登録後は JPRS 側で無効化される。
   *
   * @param payload - メールアドレス、サーバー URL、EAB 認証情報を含むペイロード
   * @throws Certbot コマンドが失敗した場合にエラーをスロー
   */
  async registerAccount(payload: RegisterPayload): Promise<void> {
    console.log(`Registering ACME account for ${payload.email}`);
    console.log(`Server: ${payload.server}`);

    // Certbot register コマンドの引数を構築
    const args = [
      'certbot register',
      '--non-interactive', // 対話モード無効（Lambda に必須）
      '--agree-tos', // 利用規約に自動同意
      `-m ${payload.email}`, // メールアドレス
      `--server ${payload.server}`, // ACME サーバー URL
      `--eab-kid ${payload.eabKid}`, // EAB Key Identifier
      `--eab-hmac-key ${payload.eabHmacKey}`, // EAB HMAC Key
      `--config-dir ${this.configDir}`, // 設定保存先
      `--work-dir ${this.workDir}`, // 作業ディレクトリ
      `--logs-dir ${this.logsDir}`, // ログ出力先
    ];

    const command = args.join(' ');
    // EAB 認証情報をログに出力しないよう注意
    console.log('Executing: certbot register (EAB credentials hidden)');

    try {
      // Certbot register コマンドを同期実行
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe', // 出力をキャプチャ
      });

      console.log('Account registered successfully');
      console.log('Output:', output);
    } catch (error: any) {
      // 登録失敗時のエラー処理
      console.error('Account registration failed:', error.message);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      throw new Error(`Certbot register failed: ${error.message}`);
    }
  }

  /**
   * Certbot を使用して証明書を取得（renew モード用）
   *
   * domains.json の設定から証明書を取得する。
   * Route53 DNS-01 チャレンジを使用して自動的にドメイン所有権を検証。
   * ACM ARN が既に存在する場合は --force-renewal フラグを使用して強制更新。
   *
   * @param config - domains.json からの証明書設定
   * @returns 取得した証明書ファイルのパス
   * @throws Certbot コマンドが失敗した場合にエラーをスロー
   */
  async obtainCertificate(config: CertificateConfig): Promise<CertbotCertificatePaths> {
    console.log(`Obtaining certificate for ${config.domains.join(', ')}`);

    // プロバイダー設定から ACME サーバー URL を取得
    const serverUrl = getServerUrl(config.acmeProvider, config.acmeServerUrl);

    // Certbot certonly コマンドを構築
    const command = this.buildCertbotCommand({
      domains: config.domains,
      email: config.email,
      serverUrl,
      route53HostedZoneId: config.route53HostedZoneId,
      forceRenewal: !!config.acmCertificateArn, // ACM ARN が存在する場合は強制更新
      keyType: config.keyType,
      rsaKeySize: config.rsaKeySize,
    });

    console.log(`Executing: ${command}`);

    try {
      // Certbot certonly コマンドを同期実行
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          // Route53 プラグインが使用する AWS リージョンを設定
          AWS_DEFAULT_REGION: process.env.AWS_REGION || 'us-east-1',
        },
      });

      console.log('Certbot output:', output);

      // 取得した証明書ファイルのパスを解決
      const certPaths = this.getCertificatePaths(config.domains[0]);

      console.log('Certificate obtained successfully');
      console.log('Paths:', certPaths);

      return certPaths;
    } catch (error: any) {
      // 証明書取得失敗時のエラー処理
      console.error('Certbot execution failed:', error.message);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      throw new Error(`Certbot failed: ${error.message}`);
    }
  }

  /**
   * Certbot を使用して証明書を取得（certonly モード用）
   *
   * イベントペイロードのパラメータから証明書を取得する。
   * Route53 DNS-01 チャレンジを使用して自動的にドメイン所有権を検証。
   *
   * @param payload - ドメイン、メール、サーバー URL などを含むペイロード
   * @returns 取得した証明書ファイルのパス
   * @throws Certbot コマンドが失敗した場合にエラーをスロー
   */
  async obtainCertificateFromPayload(payload: CertonlyPayload): Promise<CertbotCertificatePaths> {
    console.log(`Obtaining certificate for ${payload.domains.join(', ')}`);
    console.log(`Server: ${payload.server}`);

    // Certbot certonly コマンドを構築
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
      // Certbot certonly コマンドを同期実行
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          // Route53 プラグインが使用する AWS リージョンを設定
          AWS_DEFAULT_REGION: process.env.AWS_REGION || 'us-east-1',
        },
      });

      console.log('Certbot output:', output);

      // 取得した証明書ファイルのパスを解決
      const certPaths = this.getCertificatePaths(payload.domains[0]);

      console.log('Certificate obtained successfully');
      console.log('Paths:', certPaths);

      return certPaths;
    } catch (error: any) {
      // 証明書取得失敗時のエラー処理
      console.error('Certbot execution failed:', error.message);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      throw new Error(`Certbot failed: ${error.message}`);
    }
  }

  /**
   * Certbot certonly コマンドを構築
   *
   * パラメータから Certbot certonly コマンドラインを生成する。
   * キータイプ（RSA/ECDSA）、強制更新フラグなどのオプションを適切に処理。
   *
   * @param params - コマンド構築パラメータ
   * @returns 実行可能な Certbot コマンド文字列
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
    // ドメイン引数を構築（複数ドメインの場合は `-d domain1 -d domain2` の形式）
    const domainArgs = params.domains.map(d => `-d ${d}`).join(' ');
    const keyType = params.keyType || 'rsa'; // デフォルトは RSA
    const rsaKeySize = params.rsaKeySize || 2048; // デフォルトは 2048 ビット

    // Certbot certonly コマンドの基本引数
    const args = [
      'certbot certonly',
      '--non-interactive', // 対話モード無効（Lambda に必須）
      '--agree-tos', // 利用規約に自動同意
      `--email ${params.email}`, // 通知用メールアドレス
      '--dns-route53', // Route53 DNS-01 プラグインを使用
      `--server ${params.serverUrl}`, // ACME サーバー URL
      `--config-dir ${this.configDir}`, // 設定保存先
      `--work-dir ${this.workDir}`, // 作業ディレクトリ
      `--logs-dir ${this.logsDir}`, // ログ出力先
      domainArgs, // ドメインリスト
      '--preferred-challenges dns-01', // DNS-01 チャレンジを優先
      `--key-type ${keyType}`, // 証明書のキータイプ（rsa または ecdsa）
    ];

    // RSA を使用する場合のみキーサイズを指定
    if (keyType === 'rsa') {
      args.push(`--rsa-key-size ${rsaKeySize}`);
    }

    // 強制更新フラグが true の場合、既存の証明書を上書き
    if (params.forceRenewal) {
      args.push('--force-renewal');
    }

    return args.join(' ');
  }

  /**
   * 証明書ファイルのパスを取得
   *
   * Certbot が生成した証明書ファイルのパスを解決する。
   * Certbot は証明書を `config/live/<primary-domain>/` ディレクトリに保存。
   *
   * @param primaryDomain - プライマリドメイン（複数ドメインの場合は最初のドメイン）
   * @returns 証明書ファイルのパス（cert.pem, chain.pem, fullchain.pem, privkey.pem）
   * @throws 証明書ディレクトリまたはファイルが存在しない場合にエラーをスロー
   */
  private getCertificatePaths(primaryDomain: string): CertbotCertificatePaths {
    // Certbot が証明書を保存するディレクトリ
    const liveDir = path.join(this.configDir, 'live', primaryDomain);

    // ディレクトリの存在確認
    if (!fs.existsSync(liveDir)) {
      throw new Error(`Certificate directory not found: ${liveDir}`);
    }

    // 証明書ファイルのパスを構築
    const paths: CertbotCertificatePaths = {
      certPath: path.join(liveDir, 'cert.pem'), // 証明書本体
      chainPath: path.join(liveDir, 'chain.pem'), // 中間証明書チェーン
      fullChainPath: path.join(liveDir, 'fullchain.pem'), // 証明書 + チェーン
      privateKeyPath: path.join(liveDir, 'privkey.pem'), // 秘密鍵
    };

    // すべてのファイルが存在することを確認
    for (const [name, filePath] of Object.entries(paths)) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Certificate file not found: ${filePath} (${name})`);
      }
    }

    return paths;
  }

  /**
   * Certbot 作業ディレクトリをクリーンアップ
   *
   * Lambda の /tmp ディレクトリは容量制限（2GB）があるため、
   * 処理完了後にクリーンアップして空き容量を確保する。
   * クリーンアップ失敗は処理全体を中断させない（graceful）。
   */
  cleanup(): void {
    console.log('Cleaning up Certbot directories...');

    try {
      if (fs.existsSync(this.certbotDir)) {
        // 再帰的に削除（force オプションでエラー無視）
        fs.rmSync(this.certbotDir, { recursive: true, force: true });
        console.log(`Removed directory: ${this.certbotDir}`);
      }
    } catch (error: any) {
      console.error('Failed to cleanup Certbot directories:', error.message);
      // クリーンアップ失敗は処理全体を中断させない
    }
  }

  /**
   * config ディレクトリのパスを取得（S3 同期用）
   *
   * ACME アカウント情報と証明書が保存されているディレクトリのパス。
   * S3Manager がこのディレクトリと S3 を同期する。
   *
   * @returns config ディレクトリの絶対パス
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Certbot ルートディレクトリのパスを取得
   *
   * @returns Certbot ルートディレクトリの絶対パス
   */
  getCertbotDir(): string {
    return this.certbotDir;
  }
}
