/**
 * S3 の状態管理。設定の条件付き更新とバケット共通の実行ロックを提供する。
 */
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ConfigVersion { content: string; etag: string; }
export interface StorageLock { key: string; etag: string; owner: string; }

export class LockConflictError extends Error {
  constructor() {
    super('Certificate state is locked; expired locks require operator verification before removal');
    this.name = 'LockConflictError';
  }
}

export class S3Manager {
  private s3Client: S3Client;
  private bucketName: string;

  constructor(bucketName: string, region = 'us-east-1') {
    this.bucketName = bucketName;
    this.s3Client = new S3Client({ region });
  }

  async downloadConfig(key: string): Promise<string> {
    const response = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
    if (!response.Body) throw new Error('Empty response body from S3');
    return (await this.streamToBuffer(response.Body as Readable)).toString('utf-8');
  }

  async downloadConfigVersioned(key: string): Promise<ConfigVersion> {
    const response = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
    if (!response.Body || !response.ETag) throw new Error('Configuration body or ETag is missing');
    return { content: (await this.streamToBuffer(response.Body as Readable)).toString('utf-8'), etag: response.ETag };
  }

  /** etag がなければ新規作成だけを許可する。 */
  async uploadConfig(key: string, content: string, etag?: string): Promise<string> {
    const result = await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName, Key: key, Body: content, ContentType: 'application/json',
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
    }));
    if (!result.ETag) throw new Error('Configuration write ETag is missing');
    return result.ETag;
  }

  async uploadFile(key: string, content: string | Buffer): Promise<void> {
    await this.s3Client.send(new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: content }));
  }

  /**
   * バケット共通ロック。有効期限が過ぎても、前の実行の停止が確認できないので自動奪取しない。
   */
  async acquireLock(ttlSeconds = 900): Promise<StorageLock> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('Invalid lock duration');
    const key = 'locks/certbot.json';
    const owner = randomUUID();
    try {
      const result = await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName, Key: key, IfNoneMatch: '*', ContentType: 'application/json',
        Body: JSON.stringify({ owner, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() }),
      }));
      if (!result.ETag) throw new Error('Lock ETag is missing; operator verification is required');
      return { key, owner, etag: result.ETag };
    } catch (error) {
      const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (failure.name === 'PreconditionFailed' || failure.name === 'ConditionalRequestConflict' ||
          failure.$metadata?.httpStatusCode === 412 || failure.$metadata?.httpStatusCode === 409) {
        throw new LockConflictError();
      }
      throw error;
    }
  }

  async releaseLock(lock: StorageLock): Promise<void> {
    const current = await this.downloadConfigVersioned(lock.key);
    let owner: unknown;
    try { owner = (JSON.parse(current.content) as { owner?: unknown }).owner; }
    catch { throw new Error('Lock ownership could not be verified'); }
    if (owner !== lock.owner || current.etag !== lock.etag) throw new Error('Lock ownership changed; refusing to release');
    await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: lock.key, IfMatch: lock.etag }));
  }

  async syncDirectoryToS3(localDir: string, s3Prefix: string): Promise<void> {
    if (!fs.existsSync(localDir)) return;
    const root = path.resolve(localDir);
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('State root must not be a symbolic link');
    const basePrefix = this.normalizePrefix(s3Prefix);
    const generationPrefix = basePrefix + '.snapshots/' + randomUUID() + '/';
    // 全ファイルの成功後にだけ現在世代を切り替える。途中失敗した世代は参照されない。
    await this.uploadDirectory(root, root, generationPrefix);
    await this.uploadFile(basePrefix + '.snapshot.json', JSON.stringify({ version: 1, prefix: generationPrefix }));
  }

  async syncS3ToDirectory(s3Prefix: string, localDir: string): Promise<void> {
    const root = path.resolve(localDir);
    if (this.isSymbolicLink(root)) throw new Error('State root must not be a symbolic link');
    fs.mkdirSync(path.dirname(root), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(root), '.certbot-restore-'));
    const backup = root + '.previous-' + randomUUID();
    try {
      await this.restoreStateDirectory(s3Prefix, staging);
      const hadPrevious = fs.existsSync(root);
      if (hadPrevious) fs.renameSync(root, backup);
      try { fs.renameSync(staging, root); }
      catch (error) {
        if (hadPrevious) fs.renameSync(backup, root);
        throw error;
      }
      if (hadPrevious) fs.rmSync(backup, { recursive: true, force: true });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  private async restoreStateDirectory(s3Prefix: string, localDir: string): Promise<void> {
    const root = path.resolve(localDir);
    this.ensureSafeDirectory(root, root);
    const basePrefix = this.normalizePrefix(s3Prefix);
    let prefix = basePrefix;
    try {
      const manifest = JSON.parse(await this.downloadConfig(basePrefix + '.snapshot.json')) as { version?: unknown; prefix?: unknown };
      if (manifest.version !== 1 || typeof manifest.prefix !== 'string' ||
          !new RegExp('^[a-f0-9-]{36}/$').test(manifest.prefix.slice((basePrefix + '.snapshots/').length)) ||
          !manifest.prefix.startsWith(basePrefix + '.snapshots/')) {
        throw new Error('Invalid state snapshot manifest');
      }
      prefix = manifest.prefix;
    } catch (error) {
      // 権限・通信・JSONエラーでは旧世代へ戻らず中断する。
      if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
    }
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();
    const links: { localPath: string; target: string }[] = [];
    do {
      const response = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.bucketName, Prefix: prefix, ContinuationToken: continuationToken,
      }));
      for (const object of response.Contents ?? []) {
        if (!object.Key) continue;
        if (!object.Key.startsWith(prefix)) throw new Error('Unexpected state object prefix');
        const relative = object.Key.slice(prefix.length);
        if (!relative || (prefix === basePrefix && (relative === '.snapshot.json' || relative.startsWith('.snapshots/')))) continue;
        const localPath = this.safeStatePath(root, relative.replace(/\/$/, ''));
        if (object.Key.endsWith('/')) { this.ensureSafeDirectory(root, localPath); continue; }
        const file = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: object.Key }));
        if (!file.Body) throw new Error('State object body is missing');
        const content = await this.streamToBuffer(file.Body as Readable);
        const entryType = file.Metadata?.['entry-type'];
        if (entryType === 'symlink') {
          const target = content.toString('utf-8');
          this.validateLink(root, localPath, target);
          links.push({ localPath, target });
        } else if (entryType && entryType !== 'file') {
          throw new Error('Unsupported state object type');
        } else {
          // Metadata のない旧フラット形式も通常ファイルとして復元する。
          this.prepareFile(root, localPath);
          fs.writeFileSync(localPath, content, { mode: 0o600 });
          fs.chmodSync(localPath, 0o600);
        }
      }
      if (!response.IsTruncated) break;
      const next = response.NextContinuationToken;
      if (!next || seenTokens.has(next)) throw new Error('Invalid state pagination token');
      seenTokens.add(next);
      continuationToken = next;
    } while (true);
    // archive 等の通常ファイルをすべて復元してから live リンクを作る。
    for (const link of links) {
      this.prepareFile(root, link.localPath);
      fs.symlinkSync(link.target, link.localPath);
    }
    if (prefix === basePrefix) this.migrateLegacyLiveLinks(root);
  }

  /**
   * 旧保存形式では live のリンク先の内容だけが保存されていた。
   * 同一 lineage・同一世代の4 PEMすべてが一致する場合だけリンクへ戻す。
   */
  private migrateLegacyLiveLinks(root: string): void {
    const liveRoot = path.join(root, 'live');
    if (!fs.existsSync(liveRoot)) return;
    if (!fs.lstatSync(liveRoot).isDirectory()) throw new Error('Invalid legacy live directory');
    const names = ['cert', 'privkey', 'chain', 'fullchain'];
    for (const lineage of fs.readdirSync(liveRoot)) {
      const live = path.join(liveRoot, lineage);
      if (!fs.lstatSync(live).isDirectory()) continue;
      const files = names.map(name => path.join(live, name + '.pem'));
      const stats = files.map(file => {
        try { return fs.lstatSync(file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      });
      if (stats.every(stat => !stat)) continue;
      if (stats.every(stat => stat?.isSymbolicLink())) continue;
      if (!stats.every(stat => stat?.isFile() && !stat.isSymbolicLink())) {
        throw new Error('Legacy live state is incomplete; manual recovery is required');
      }
      const archive = path.join(root, 'archive', lineage);
      if (!fs.existsSync(archive) || !fs.lstatSync(archive).isDirectory()) {
        throw new Error('Legacy live state requires a matching archive generation');
      }
      const generations = fs.readdirSync(archive)
        .map(file => /^cert([1-9][0-9]*)\.pem$/.exec(file)?.[1])
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Number(right) - Number(left));
      const generation = generations.find(candidate => names.every((name, index) => {
        const archived = path.join(archive, name + candidate + '.pem');
        try {
          const stat = fs.lstatSync(archived);
          return stat.isFile() && !stat.isSymbolicLink() &&
            fs.readFileSync(archived).equals(fs.readFileSync(files[index]));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }));
      if (!generation) throw new Error('Legacy live state requires a matching archive generation');
      for (let index = 0; index < names.length; index++) {
        fs.unlinkSync(files[index]);
        fs.symlinkSync('../../archive/' + lineage + '/' + names[index] + generation + '.pem', files[index]);
      }
    }
  }

  async saveCertificateBackup(
    certificateId: string, certPath: string, keyPath: string, chainPath: string, fullChainPath: string
  ): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `certificates/${certificateId}/${timestamp}`;
    await this.uploadFile(`${prefix}/cert.pem`, fs.readFileSync(certPath));
    await this.uploadFile(`${prefix}/privkey.pem`, fs.readFileSync(keyPath));
    await this.uploadFile(`${prefix}/chain.pem`, fs.readFileSync(chainPath));
    await this.uploadFile(`${prefix}/fullchain.pem`, fs.readFileSync(fullChainPath));
  }

  private async uploadDirectory(root: string, dir: string, prefix: string): Promise<void> {
    for (const entry of fs.readdirSync(dir)) {
      const filePath = path.join(dir, entry);
      const stat = fs.lstatSync(filePath);
      if (stat.isDirectory()) {
        await this.uploadDirectory(root, filePath, prefix);
      } else {
        const key = prefix + path.relative(root, filePath).split(path.sep).join('/');
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(filePath);
          this.validateLink(root, filePath, target);
          await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucketName, Key: key, Body: target, Metadata: { 'entry-type': 'symlink' },
          }));
        } else if (stat.isFile()) {
          await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucketName, Key: key, Body: fs.readFileSync(filePath), Metadata: { 'entry-type': 'file' },
          }));
        } else { throw new Error('Unsupported local state entry'); }
      }
    }
  }

  private normalizePrefix(prefix: string): string { return prefix.replace(/\/+$/, '') + '/'; }

  private safeStatePath(root: string, relative: string): string {
    if (!relative || relative.includes('\\') || relative.includes('\0') ||
        path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe state object path');
    }
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(root + path.sep)) throw new Error('State path escapes local root');
    return resolved;
  }

  private validateLink(root: string, localPath: string, target: string): void {
    if (!target || target.includes('\0') || target.includes('\\') || path.isAbsolute(target)) {
      throw new Error('Unsafe state symbolic link');
    }
    const resolved = path.resolve(path.dirname(localPath), target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('State symbolic link escapes local root');
  }

  private ensureSafeDirectory(root: string, directory: string): void {
    const relative = path.relative(root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe state directory');
    let current = root;
    const segments = relative ? relative.split(path.sep) : [];
    for (let index = -1; index < segments.length; index++) {
      if (index >= 0) current = path.join(current, segments[index]);
      if (fs.existsSync(current) || this.isSymbolicLink(current)) {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('State directory is not a regular directory');
      } else { fs.mkdirSync(current, { recursive: current === root, mode: 0o700 }); }
    }
  }

  private isSymbolicLink(file: string): boolean {
    try { return fs.lstatSync(file).isSymbolicLink(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private prepareFile(root: string, file: string): void {
    this.ensureSafeDirectory(root, path.dirname(file));
    if (fs.existsSync(file) || this.isSymbolicLink(file)) {
      if (fs.lstatSync(file).isDirectory()) throw new Error('State file conflicts with a directory');
      fs.unlinkSync(file);
    }
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
