import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

/**
 * S3Manager handles all S3 operations for certificate storage and configuration
 */
export class S3Manager {
  private s3Client: S3Client;
  private bucketName: string;

  constructor(bucketName: string, region = 'us-east-1') {
    this.bucketName = bucketName;
    this.s3Client = new S3Client({ region });
  }

  /**
   * Download configuration file from S3
   */
  async downloadConfig(key: string): Promise<string> {
    console.log(`Downloading configuration from s3://${this.bucketName}/${key}`);

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    const response = await this.s3Client.send(command);

    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }

    return this.streamToString(response.Body as Readable);
  }

  /**
   * Upload file to S3
   */
  async uploadFile(key: string, content: string | Buffer): Promise<void> {
    console.log(`Uploading file to s3://${this.bucketName}/${key}`);

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: content,
    });

    await this.s3Client.send(command);
  }

  /**
   * Sync local directory to S3 prefix (upload)
   */
  async syncDirectoryToS3(localDir: string, s3Prefix: string): Promise<void> {
    if (!fs.existsSync(localDir)) {
      console.log(`Local directory ${localDir} does not exist, skipping sync`);
      return;
    }

    console.log(`Syncing ${localDir} to s3://${this.bucketName}/${s3Prefix}`);

    await this.uploadDirectory(localDir, s3Prefix);
  }

  /**
   * Sync S3 prefix to local directory (download)
   */
  async syncS3ToDirectory(s3Prefix: string, localDir: string): Promise<void> {
    console.log(`Syncing s3://${this.bucketName}/${s3Prefix} to ${localDir}`);

    // Ensure local directory exists
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    // List all objects under the prefix
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: s3Prefix,
    });

    const response = await this.s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      console.log(`No files found at s3://${this.bucketName}/${s3Prefix}`);
      return;
    }

    // Download each file
    for (const obj of response.Contents) {
      if (!obj.Key) continue;

      const relativePath = obj.Key.substring(s3Prefix.length).replace(/^\//, '');
      if (!relativePath) continue; // Skip the prefix itself

      const localPath = path.join(localDir, relativePath);

      // Create directory if needed
      const dirName = path.dirname(localPath);
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }

      // Download file
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: obj.Key,
      });

      const fileResponse = await this.s3Client.send(getCommand);

      if (fileResponse.Body) {
        const content = await this.streamToBuffer(fileResponse.Body as Readable);
        fs.writeFileSync(localPath, content);
        console.log(`Downloaded ${obj.Key} to ${localPath}`);
      }
    }
  }

  /**
   * Save certificate files to S3 with timestamp
   */
  async saveCertificateBackup(
    certificateId: string,
    certPath: string,
    keyPath: string,
    chainPath: string,
    fullChainPath: string
  ): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `certificates/${certificateId}/${timestamp}`;

    console.log(`Backing up certificate to s3://${this.bucketName}/${prefix}`);

    // Upload all certificate files
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
   * Recursively upload directory to S3
   */
  private async uploadDirectory(localDir: string, s3Prefix: string): Promise<void> {
    const files = this.getAllFiles(localDir);

    for (const filePath of files) {
      const relativePath = path.relative(localDir, filePath);
      const s3Key = path.join(s3Prefix, relativePath).replace(/\\/g, '/');

      const content = fs.readFileSync(filePath);
      await this.uploadFile(s3Key, content);
    }
  }

  /**
   * Get all files in a directory recursively
   */
  private getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      if (fs.statSync(filePath).isDirectory()) {
        arrayOfFiles = this.getAllFiles(filePath, arrayOfFiles);
      } else {
        arrayOfFiles.push(filePath);
      }
    }

    return arrayOfFiles;
  }

  /**
   * Convert stream to string
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
   * Convert stream to buffer
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
