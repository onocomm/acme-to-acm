/**
 * Certbot コマンド実行マネージャー
 *
 * Certbot CLI を実行して ACME サーバーから SSL/TLS 証明書を取得するためのラッパークラス。
 * Lambda の /tmp ディレクトリに作業ディレクトリを作成し、証明書取得、アカウント登録、
 * ファイルパス解決などの機能を提供する。
 */

import { execFileSync } from 'child_process';
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
    console.log(`Registering ACME account for ${payload.input.email}`);
    console.log(`Server: ${payload.input.server}`);

    // Certbot register コマンドの引数を配列で構築（コマンドインジェクション対策）
    const args = [
      'register',
      '--non-interactive', // 対話モード無効（Lambda に必須）
      '--agree-tos', // 利用規約に自動同意
      '-m', payload.input.email, // メールアドレス
      '--server', payload.input.server, // ACME サーバー URL
      '--eab-kid', payload.input.eabKid, // EAB Key Identifier
      '--eab-hmac-key', payload.input.eabHmacKey, // EAB HMAC Key
      '--config-dir', this.configDir, // 設定保存先
      '--work-dir', this.workDir, // 作業ディレクトリ
      '--logs-dir', this.logsDir, // ログ出力先
    ];

    // EAB 認証情報をログに出力しないよう注意
    console.log('Executing: certbot register (EAB credentials hidden)');

    try {
      // Certbot register コマンドを同期実行（execFileSync でシェル経由しない）
      const output = execFileSync('certbot', args, {
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
   * --cert-name オプションで lineage 名を固定し、番号付きディレクトリの発生を防止。
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
    const { args } = this.buildCertbotCommand({
      domains: config.domains,
      email: config.email,
      serverUrl,
      route53HostedZoneId: config.route53HostedZoneId,
      forceRenewal: !!config.acmCertificateArn, // ACM ARN が存在する場合は強制更新
      keyType: config.keyType,
      rsaKeySize: config.rsaKeySize,
      certName: config.domains[0], // lineage 名を固定して番号付きディレクトリを防止
    });

    console.log(`Executing: certbot ${args.join(' ')}`);

    try {
      // Certbot certonly コマンドを同期実行（execFileSync でシェル経由しない）
      const output = execFileSync('certbot', args, {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          // Route53 プラグインが使用する AWS リージョンを設定
          AWS_DEFAULT_REGION: process.env.AWS_REGION || 'us-east-1',
        },
      });

      console.log('Certbot output:', output);

      // Certbot の stdout から証明書の保存先ディレクトリを解析
      const certDir = this.parseCertificateDir(output);

      // 取得した証明書ファイルのパスを解決
      const certPaths = this.getCertificatePaths(config.domains[0], certDir);

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
   * --cert-name オプションで lineage 名を固定し、番号付きディレクトリの発生を防止。
   *
   * @param payload - ドメイン、メール、サーバー URL などを含むペイロード
   * @returns 取得した証明書ファイルのパス
   * @throws Certbot コマンドが失敗した場合にエラーをスロー
   */
  async obtainCertificateFromPayload(payload: CertonlyPayload): Promise<CertbotCertificatePaths> {
    console.log(`Obtaining certificate for ${payload.input.domains.join(', ')}`);
    console.log(`Server: ${payload.input.server}`);

    // Certbot certonly コマンドを構築
    const { args } = this.buildCertbotCommand({
      domains: payload.input.domains,
      email: payload.input.email,
      serverUrl: payload.input.server,
      route53HostedZoneId: payload.input.route53HostedZoneId,
      forceRenewal: payload.input.forceRenewal || false,
      keyType: payload.input.keyType,
      rsaKeySize: payload.input.rsaKeySize,
      certName: payload.input.domains[0], // lineage 名を固定して番号付きディレクトリを防止
    });

    console.log(`Executing: certbot ${args.join(' ')}`);

    try {
      // Certbot certonly コマンドを同期実行（execFileSync でシェル経由しない）
      const output = execFileSync('certbot', args, {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          // Route53 プラグインが使用する AWS リージョンを設定
          AWS_DEFAULT_REGION: process.env.AWS_REGION || 'us-east-1',
        },
      });

      console.log('Certbot output:', output);

      // Certbot の stdout から証明書の保存先ディレクトリを解析
      const certDir = this.parseCertificateDir(output);

      // 取得した証明書ファイルのパスを解決
      const certPaths = this.getCertificatePaths(payload.input.domains[0], certDir);

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
   * パラメータから Certbot certonly コマンドの引数配列を生成する。
   * キータイプ（RSA/ECDSA）、強制更新フラグ、cert-name などのオプションを適切に処理。
   * execFileSync 用に引数を配列として返す（コマンドインジェクション対策）。
   *
   * @param params - コマンド構築パラメータ
   * @returns コマンド名と引数配列
   */
  private buildCertbotCommand(params: {
    domains: string[];
    email: string;
    serverUrl: string;
    route53HostedZoneId: string;
    forceRenewal: boolean;
    keyType?: 'rsa' | 'ecdsa';
    rsaKeySize?: 2048 | 4096;
    certName?: string;
  }): { command: string; args: string[] } {
    const keyType = params.keyType || 'rsa'; // デフォルトは RSA
    const rsaKeySize = params.rsaKeySize || 2048; // デフォルトは 2048 ビット

    // Certbot certonly コマンドの引数を配列で構築
    const args: string[] = [
      'certonly',
      '--non-interactive', // 対話モード無効（Lambda に必須）
      '--agree-tos', // 利用規約に自動同意
      '--email', params.email, // 通知用メールアドレス
      '--dns-route53', // Route53 DNS-01 プラグインを使用
      '--server', params.serverUrl, // ACME サーバー URL
      '--config-dir', this.configDir, // 設定保存先
      '--work-dir', this.workDir, // 作業ディレクトリ
      '--logs-dir', this.logsDir, // ログ出力先
      ...params.domains.flatMap(d => ['-d', d]), // ドメインリスト
      '--preferred-challenges', 'dns-01', // DNS-01 チャレンジを優先
      '--key-type', keyType, // 証明書のキータイプ（rsa または ecdsa）
    ];

    // RSA を使用する場合のみキーサイズを指定
    if (keyType === 'rsa') {
      args.push('--rsa-key-size', String(rsaKeySize));
    }

    // 強制更新フラグが true の場合、既存の証明書を上書き
    if (params.forceRenewal) {
      args.push('--force-renewal');
    }

    // cert-name を指定して lineage 名を固定（番号付きディレクトリの発生を防止）
    if (params.certName) {
      args.push('--cert-name', params.certName);
    }

    return { command: 'certbot', args };
  }

  /**
   * Certbot の stdout から証明書の保存先ディレクトリを解析する
   *
   * Certbot の出力には以下の形式で保存先パスが含まれる:
   *   Certificate is saved at: /tmp/certbot/config/live/example.com/fullchain.pem
   *   Key is saved at:         /tmp/certbot/config/live/example.com/privkey.pem
   *
   * @param stdout - Certbot の標準出力
   * @returns 証明書ディレクトリの絶対パス、または解析失敗時は null
   */
  private parseCertificateDir(stdout: string): string | null {
    // "Certificate is saved at:" パターンで解析
    const certMatch = stdout.match(/Certificate is saved at:\s+(.+)\/fullchain\.pem/);
    if (certMatch) {
      console.log(`Parsed certificate directory from Certbot output: ${certMatch[1]}`);
      return certMatch[1];
    }

    // "Key is saved at:" パターンでフォールバック
    const keyMatch = stdout.match(/Key is saved at:\s+(.+)\/privkey\.pem/);
    if (keyMatch) {
      console.log(`Parsed certificate directory from Certbot key output: ${keyMatch[1]}`);
      return keyMatch[1];
    }

    console.log('Could not parse certificate directory from Certbot output');
    return null;
  }

  /**
   * 最新の証明書ディレクトリを検索する（番号付きディレクトリ対応）
   *
   * live/ ディレクトリ内の {domain} および {domain}-NNNN パターンにマッチする
   * ディレクトリを検索し、最大番号のディレクトリを返す。
   * --cert-name 指定時のフォールバックとして使用。
   *
   * @param primaryDomain - プライマリドメイン
   * @returns 最新の証明書ディレクトリの絶対パス
   * @throws ディレクトリが見つからない場合にエラーをスロー
   */
  private findLatestCertDir(primaryDomain: string): string {
    const liveBaseDir = path.join(this.configDir, 'live');

    if (!fs.existsSync(liveBaseDir)) {
      throw new Error(`Live directory not found: ${liveBaseDir}`);
    }

    const entries = fs.readdirSync(liveBaseDir, { withFileTypes: true });

    // ドメイン名の正規表現特殊文字をエスケープ
    const escapedDomain = primaryDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // {domain} と {domain}-NNNN のパターンにマッチ
    const pattern = new RegExp(`^${escapedDomain}(-\\d+)?$`);

    const matchingDirs = entries
      .filter(e => e.isDirectory() && pattern.test(e.name))
      .map(e => e.name)
      .sort((a, b) => {
        // 番号なし（元のディレクトリ）は -1 として扱い、番号付きが優先される
        const numA = parseInt(a.match(/-(\d+)$/)?.[1] ?? '-1');
        const numB = parseInt(b.match(/-(\d+)$/)?.[1] ?? '-1');
        return numB - numA; // 降順（最大番号が先頭）
      });

    if (matchingDirs.length === 0) {
      throw new Error(`No certificate directory found for ${primaryDomain} in ${liveBaseDir}`);
    }

    const result = path.join(liveBaseDir, matchingDirs[0]);
    console.log(`Found latest certificate directory: ${result}`);
    return result;
  }

  /**
   * 証明書ファイルのパスを取得
   *
   * Certbot が生成した証明書ファイルのパスを解決する。
   * 以下の優先順位でディレクトリを決定:
   * 1. Certbot stdout から解析したパス（certbotOutputDir）
   * 2. デフォルトパス: config/live/{primaryDomain}/
   * 3. フォールバック: config/live/ 内の番号付きディレクトリを検索
   *
   * @param primaryDomain - プライマリドメイン（複数ドメインの場合は最初のドメイン）
   * @param certbotOutputDir - Certbot stdout から解析した保存先ディレクトリ（省略可）
   * @returns 証明書ファイルのパス（cert.pem, chain.pem, fullchain.pem, privkey.pem）
   * @throws 証明書ディレクトリまたはファイルが存在しない場合にエラーをスロー
   */
  private getCertificatePaths(primaryDomain: string, certbotOutputDir?: string | null): CertbotCertificatePaths {
    let liveDir: string;

    if (certbotOutputDir && fs.existsSync(certbotOutputDir)) {
      // 1. Certbot stdout から解析したパスを優先
      liveDir = certbotOutputDir;
      console.log(`Using certificate directory from Certbot output: ${liveDir}`);
    } else {
      // 2. --cert-name 指定時は番号なしディレクトリが存在するはず
      const defaultDir = path.join(this.configDir, 'live', primaryDomain);
      if (fs.existsSync(defaultDir)) {
        liveDir = defaultDir;
      } else {
        // 3. フォールバック: 番号付きディレクトリを検索
        console.log(`Default directory not found: ${defaultDir}, searching for numbered directories...`);
        liveDir = this.findLatestCertDir(primaryDomain);
      }
      console.log(`Using certificate directory: ${liveDir}`);
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
