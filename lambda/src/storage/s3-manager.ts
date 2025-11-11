/**
 * S3 操作マネージャー
 *
 * 証明書ストレージと設定管理のための S3 操作を提供する。
 * Certbot 設定の同期、証明書バックアップ、domains.json のダウンロード/アップロードを担当。
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

/**
 * S3Manager - S3 操作を管理するクラス
 */
export class S3Manager {
  private s3Client: S3Client;
  private bucketName: string;

  /**
   * コンストラクタ
   * @param bucketName - S3 バケット名
   * @param region - AWS リージョン（デフォルト: us-east-1）
   */
  constructor(bucketName: string, region = 'us-east-1') {
    this.bucketName = bucketName;
    this.s3Client = new S3Client({ region });
  }

  /**
   * S3 から設定ファイルをダウンロード
   *
   * domains.json などの設定ファイルを S3 からダウンロードして文字列として返す。
   *
   * @param key - S3 オブジェクトキー（例: config/domains.json）
   * @returns ファイル内容（文字列）
   * @throws ファイルが存在しない、または空の場合にエラーをスロー
   */
  async downloadConfig(key: string): Promise<string> {
    console.log(`Downloading configuration from s3://${this.bucketName}/${key}`);

    // S3 GetObject コマンドを実行
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    const response = await this.s3Client.send(command);

    // レスポンスボディの存在確認
    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }

    // ストリームを文字列に変換して返却
    return this.streamToString(response.Body as Readable);
  }

  /**
   * S3 にファイルをアップロード
   *
   * 文字列またはバッファを S3 にアップロードする。
   *
   * @param key - S3 オブジェクトキー
   * @param content - アップロードする内容（文字列または Buffer）
   */
  async uploadFile(key: string, content: string | Buffer): Promise<void> {
    console.log(`Uploading file to s3://${this.bucketName}/${key}`);

    // S3 PutObject コマンドを実行
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: content,
    });

    await this.s3Client.send(command);
  }

  /**
   * ローカルディレクトリを S3 プレフィックスに同期（アップロード）
   *
   * Certbot 設定ディレクトリなどをローカルから S3 にアップロードする。
   * ディレクトリ内の全ファイルを再帰的にアップロード。
   *
   * @param localDir - ローカルディレクトリの絶対パス
   * @param s3Prefix - S3 プレフィックス（例: certbot）
   */
  async syncDirectoryToS3(localDir: string, s3Prefix: string): Promise<void> {
    // ローカルディレクトリの存在確認
    if (!fs.existsSync(localDir)) {
      console.log(`Local directory ${localDir} does not exist, skipping sync`);
      return;
    }

    console.log(`Syncing ${localDir} to s3://${this.bucketName}/${s3Prefix}`);

    // ディレクトリ全体を再帰的にアップロード
    await this.uploadDirectory(localDir, s3Prefix);
  }

  /**
   * S3 プレフィックスをローカルディレクトリに同期（ダウンロード）
   *
   * S3 からファイルをダウンロードしてローカルディレクトリに保存する。
   * Certbot 設定の復元などに使用。
   *
   * @param s3Prefix - S3 プレフィックス（例: certbot）
   * @param localDir - ローカルディレクトリの絶対パス
   */
  async syncS3ToDirectory(s3Prefix: string, localDir: string): Promise<void> {
    console.log(`Syncing s3://${this.bucketName}/${s3Prefix} to ${localDir}`);

    // ローカルディレクトリを作成（存在しない場合）
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    // S3 プレフィックス配下の全オブジェクトをリスト
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: s3Prefix,
    });

    const response = await this.s3Client.send(command);

    // ファイルが存在しない場合はスキップ
    if (!response.Contents || response.Contents.length === 0) {
      console.log(`No files found at s3://${this.bucketName}/${s3Prefix}`);
      return;
    }

    // 各ファイルをダウンロード
    for (const obj of response.Contents) {
      if (!obj.Key) continue;

      // S3 キーから相対パスを抽出
      const relativePath = obj.Key.substring(s3Prefix.length).replace(/^\//, '');
      if (!relativePath) continue; // プレフィックス自体はスキップ

      const localPath = path.join(localDir, relativePath);

      // ディレクトリを作成（必要な場合）
      const dirName = path.dirname(localPath);
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }

      // ファイルをダウンロード
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: obj.Key,
      });

      const fileResponse = await this.s3Client.send(getCommand);

      // ファイル内容をローカルに書き込み
      if (fileResponse.Body) {
        const content = await this.streamToBuffer(fileResponse.Body as Readable);
        fs.writeFileSync(localPath, content);
        console.log(`Downloaded ${obj.Key} to ${localPath}`);
      }
    }
  }

  /**
   * 証明書ファイルをタイムスタンプ付きで S3 にバックアップ
   *
   * 取得した証明書ファイルを S3 にバックアップする。
   * タイムスタンプ（ISO 8601 形式）をディレクトリ名に含めることで、履歴を保持。
   *
   * バックアップ構造: certificates/{certificateId}/{timestamp}/
   *   - cert.pem
   *   - privkey.pem
   *   - chain.pem
   *   - fullchain.pem
   *
   * @param certificateId - 証明書 ID
   * @param certPath - 証明書ファイルのパス
   * @param keyPath - 秘密鍵ファイルのパス
   * @param chainPath - チェーンファイルのパス
   * @param fullChainPath - フルチェーンファイルのパス
   */
  async saveCertificateBackup(
    certificateId: string,
    certPath: string,
    keyPath: string,
    chainPath: string,
    fullChainPath: string
  ): Promise<void> {
    // タイムスタンプを生成（コロンやドットを S3 キーで使いやすいようにハイフンに変換）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `certificates/${certificateId}/${timestamp}`;

    console.log(`Backing up certificate to s3://${this.bucketName}/${prefix}`);

    // 各証明書ファイルをアップロード
    await this.uploadFile(
      `${prefix}/cert.pem`,
      fs.readFileSync(certPath)
    );

    await this.uploadFile(
      `${prefix}/privkey.pem`,
      fs.readFileSync(keyPath)
    );

    await this.uploadFile(
      `${prefix}/chain.pem`,
      fs.readFileSync(chainPath)
    );

    await this.uploadFile(
      `${prefix}/fullchain.pem`,
      fs.readFileSync(fullChainPath)
    );

    console.log(`Certificate backup completed at s3://${this.bucketName}/${prefix}`);
  }

  /**
   * ディレクトリを再帰的に S3 にアップロード（private メソッド）
   *
   * @param localDir - ローカルディレクトリの絶対パス
   * @param s3Prefix - S3 プレフィックス
   */
  private async uploadDirectory(localDir: string, s3Prefix: string): Promise<void> {
    // ディレクトリ内の全ファイルを再帰的に取得
    const files = this.getAllFiles(localDir);

    // 各ファイルをアップロード
    for (const filePath of files) {
      const relativePath = path.relative(localDir, filePath);
      // Windows パスセパレータをスラッシュに変換（S3 キー用）
      const s3Key = path.join(s3Prefix, relativePath).replace(/\\/g, '/');

      const content = fs.readFileSync(filePath);
      await this.uploadFile(s3Key, content);
    }
  }

  /**
   * ディレクトリ内の全ファイルを再帰的に取得（private メソッド）
   *
   * @param dirPath - ディレクトリパス
   * @param arrayOfFiles - ファイルパスの配列（再帰呼び出し用）
   * @returns 全ファイルパスの配列
   */
  private getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      if (fs.statSync(filePath).isDirectory()) {
        // ディレクトリの場合は再帰的に処理
        arrayOfFiles = this.getAllFiles(filePath, arrayOfFiles);
      } else {
        // ファイルの場合は配列に追加
        arrayOfFiles.push(filePath);
      }
    }

    return arrayOfFiles;
  }

  /**
   * ストリームを文字列に変換（private メソッド）
   *
   * S3 GetObject の Body（Readable ストリーム）を文字列に変換する。
   *
   * @param stream - Readable ストリーム
   * @returns 文字列（UTF-8）
   */
  private async streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  /**
   * ストリームを Buffer に変換（private メソッド）
   *
   * S3 GetObject の Body（Readable ストリーム）を Buffer に変換する。
   *
   * @param stream - Readable ストリーム
   * @returns Buffer
   */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}
