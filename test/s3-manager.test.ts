import { S3Manager, LockConflictError } from '../lambda/src/storage/s3-manager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

type Command = { constructor: { name: string }; input: Record<string, any> };
type Stored = { body: Buffer; etag: string; metadata?: Record<string, string> };

function missing(): Error { return Object.assign(new Error('missing'), { name: 'NoSuchKey' }); }
function conflict(): Error { return Object.assign(new Error('conflict'), { name: 'PreconditionFailed' }); }
function managerWith(send: (command: Command) => Promise<any>): S3Manager {
  const manager = new S3Manager('shared-bucket');
  (manager as unknown as { s3Client: { send: typeof send } }).s3Client = { send };
  return manager;
}

function memoryStore() {
  const objects = new Map<string, Stored>();
  let revision = 0;
  const send = jest.fn(async (command: Command) => {
    const input = command.input;
    const key = input.Key as string;
    const current = objects.get(key);
    switch (command.constructor.name) {
      case 'GetObjectCommand':
        if (!current) throw missing();
        return { Body: Readable.from([current.body]), ETag: current.etag, Metadata: current.metadata };
      case 'PutObjectCommand':
        if ((input.IfNoneMatch === '*' && current) || (input.IfMatch && input.IfMatch !== current?.etag)) throw conflict();
        const etag = '"revision-' + ++revision + '"';
        objects.set(key, { body: Buffer.from(input.Body), metadata: input.Metadata, etag });
        return { ETag: etag };
      case 'DeleteObjectCommand':
        if (input.IfMatch && current?.etag !== input.IfMatch) throw conflict();
        objects.delete(key);
        return {};
      case 'ListObjectsV2Command':
        return { Contents: [...objects.keys()].filter(key => key.startsWith(input.Prefix)).sort().map(Key => ({ Key })) };
      default: throw new Error('Unexpected command');
    }
  });
  return { objects, send, manager: managerWith(send) };
}

describe('S3 configuration and state safety', () => {
  let temporary: string;
  beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-storage-test-')); });
  afterEach(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

  test('configuration creates once and rejects writes from an outdated ETag', async () => {
    const { manager } = memoryStore();
    const createdEtag = await manager.uploadConfig('config/domains.json', '{"certificates":[]}');
    const first = await manager.downloadConfigVersioned('config/domains.json');
    expect(createdEtag).toBe(first.etag);
    await expect(manager.uploadConfig('config/domains.json', '{}')).rejects.toMatchObject({ name: 'PreconditionFailed' });
    const updatedEtag = await manager.uploadConfig('config/domains.json', '{"version":2}', first.etag);
    expect(updatedEtag).not.toBe(first.etag);
    expect(updatedEtag).toBe((await manager.downloadConfigVersioned('config/domains.json')).etag);
    await expect(manager.uploadConfig('config/domains.json', '{}', first.etag)).rejects.toMatchObject({ name: 'PreconditionFailed' });
    expect(await manager.downloadConfig('config/domains.json')).toBe('{"version":2}');
  });

  test('configuration writes stop if the service does not return the written ETag', async () => {
    const manager = managerWith(async () => ({}));
    await expect(manager.uploadConfig('config/domains.json', '{}')).rejects.toThrow('Configuration write ETag is missing');
  });

  test('different function instances cannot acquire a lock for the same bucket', async () => {
    const { manager, send } = memoryStore();
    const other = managerWith(send);
    const lock = await manager.acquireLock();
    await expect(other.acquireLock()).rejects.toBeInstanceOf(LockConflictError);
    await manager.releaseLock(lock);
    await expect(other.acquireLock()).resolves.toMatchObject({ key: lock.key });
  });

  test('an expired lock cannot be stolen automatically', async () => {
    const { manager, objects } = memoryStore();
    objects.set('locks/certbot.json', { body: Buffer.from('{"owner":"previous","expiresAt":"2000-01-01T00:00:00Z"}'), etag: 'old' });
    await expect(manager.acquireLock()).rejects.toBeInstanceOf(LockConflictError);
    expect(objects.get('locks/certbot.json')?.etag).toBe('old');
  });

  test('release checks the owner and uses a conditional delete', async () => {
    const { manager, objects, send } = memoryStore();
    const lock = await manager.acquireLock();
    const original = objects.get(lock.key)!;
    objects.set(lock.key, { body: Buffer.from('{"owner":"someone-else"}'), etag: 'changed' });
    await expect(manager.releaseLock(lock)).rejects.toThrow('ownership changed');
    expect(objects.has(lock.key)).toBe(true);
    objects.set(lock.key, original);
    await manager.releaseLock(lock);
    expect(send.mock.calls.find(([command]) => command.constructor.name === 'DeleteObjectCommand')?.[0].input.IfMatch).toBe(lock.etag);
  });

  test('snapshot round trip preserves Certbot live links and private key permissions', async () => {
    const { manager, objects } = memoryStore();
    const source = path.join(temporary, 'source');
    const restored = path.join(temporary, 'restored');
    fs.mkdirSync(path.join(source, 'archive/example'), { recursive: true });
    fs.mkdirSync(path.join(source, 'live/example'), { recursive: true });
    fs.writeFileSync(path.join(source, 'archive/example/privkey1.pem'), 'private-key-content');
    fs.symlinkSync('../../archive/example/privkey1.pem', path.join(source, 'live/example/privkey.pem'));
    await manager.syncDirectoryToS3(source, 'certbot');
    expect([...objects.values()].some(value => value.metadata?.['entry-type'] === 'symlink' && value.body.toString() === '../../archive/example/privkey1.pem')).toBe(true);
    await manager.syncS3ToDirectory('certbot', restored);
    const live = path.join(restored, 'live/example/privkey.pem');
    expect(fs.lstatSync(live).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(live)).toBe('../../archive/example/privkey1.pem');
    expect(fs.readFileSync(live, 'utf8')).toBe('private-key-content');
    expect(fs.statSync(live).mode & 0o777).toBe(0o600);
  });

  test('legacy files follow pagination even through an empty page', async () => {
    const pages: (string | undefined)[] = [];
    const manager = managerWith(async command => {
      const input = command.input;
      if (command.constructor.name === 'GetObjectCommand') {
        if (input.Key.endsWith('.snapshot.json')) throw missing();
        return { Body: Readable.from([Buffer.from(input.Key)]), ETag: 'etag' };
      }
      pages.push(input.ContinuationToken);
      if (!input.ContinuationToken) return { Contents: [{ Key: 'certbot/one' }], IsTruncated: true, NextContinuationToken: 'page2' };
      if (input.ContinuationToken === 'page2') return { Contents: [], IsTruncated: true, NextContinuationToken: 'page3' };
      return { Contents: [{ Key: 'certbot/nested/three' }], IsTruncated: false };
    });
    await manager.syncS3ToDirectory('certbot', path.join(temporary, 'restored'));
    expect(pages).toEqual([undefined, 'page2', 'page3']);
    expect(fs.readFileSync(path.join(temporary, 'restored/nested/three'), 'utf8')).toBe('certbot/nested/three');
  });

  test('failed snapshot uploads leave the previous generation selected', async () => {
    const { manager, objects, send } = memoryStore();
    const source = path.join(temporary, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'one'), 'previous');
    await manager.syncDirectoryToS3(source, 'certbot');
    const previous = objects.get('certbot/.snapshot.json')!.body.toString();
    fs.writeFileSync(path.join(source, 'one'), 'new');
    const failing = managerWith(async command => {
      if (command.constructor.name === 'PutObjectCommand' && command.input.Key.endsWith('/two')) throw new Error('upload failed');
      return send(command);
    });
    fs.writeFileSync(path.join(source, 'two'), 'new');
    await expect(failing.syncDirectoryToS3(source, 'certbot')).rejects.toThrow('upload failed');
    expect(objects.get('certbot/.snapshot.json')!.body.toString()).toBe(previous);
    await manager.syncS3ToDirectory('certbot', path.join(temporary, 'restored'));
    expect(fs.readFileSync(path.join(temporary, 'restored/one'), 'utf8')).toBe('previous');
    expect(fs.existsSync(path.join(temporary, 'restored/two'))).toBe(false);
  });

  test.each(['../escape', '/absolute', 'nested/../../escape', 'back\\slash'])('rejects unsafe remote paths: %s', async relative => {
    const { manager, objects } = memoryStore();
    objects.set('certbot/' + relative, { body: Buffer.from('data'), etag: 'etag' });
    await expect(manager.syncS3ToDirectory('certbot', path.join(temporary, 'restored'))).rejects.toThrow('Unsafe state object path');
    expect(fs.existsSync(path.join(temporary, 'escape'))).toBe(false);
  });

  test('rejects symbolic links escaping the state root during upload and restore', async () => {
    const { manager, objects } = memoryStore();
    const source = path.join(temporary, 'source');
    fs.mkdirSync(source);
    fs.symlinkSync('../../escape', path.join(source, 'link'));
    await expect(manager.syncDirectoryToS3(source, 'certbot')).rejects.toThrow('escapes local root');
    objects.set('certbot/link', { body: Buffer.from('/etc/passwd'), etag: 'etag', metadata: { 'entry-type': 'symlink' } });
    await expect(manager.syncS3ToDirectory('certbot', path.join(temporary, 'restored'))).rejects.toThrow('Unsafe state symbolic link');
  });

  test('failed restore preserves the existing directory and does not reuse a partial download', async () => {
    const { manager, objects } = memoryStore();
    const restored = path.join(temporary, 'restored');
    fs.mkdirSync(restored);
    fs.writeFileSync(path.join(restored, 'existing'), 'keep');
    objects.set('certbot/one', { body: Buffer.from('new'), etag: 'etag' });
    objects.set('certbot/z/../../escape', { body: Buffer.from('bad'), etag: 'etag' });
    await expect(manager.syncS3ToDirectory('certbot', restored)).rejects.toThrow('Unsafe state object path');
    expect(fs.readFileSync(path.join(restored, 'existing'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(restored, 'one'))).toBe(false);
    expect(fs.readdirSync(temporary)).toEqual(['restored']);
  });

  test('legacy flattened live PEM files migrate only to a complete matching archive generation', async () => {
    const { manager, objects } = memoryStore();
    const names = ['cert', 'privkey', 'chain', 'fullchain'];
    for (const name of names) {
      for (const generation of [1, 2]) {
        objects.set('certbot/archive/example.com/' + name + generation + '.pem', {
          body: Buffer.from(name + ':' + generation), etag: 'legacy',
        });
      }
      objects.set('certbot/live/example.com/' + name + '.pem', { body: Buffer.from(name + ':2'), etag: 'legacy' });
    }
    objects.set('certbot/live/example.com/README', { body: Buffer.from('legacy readme'), etag: 'legacy' });
    const restored = path.join(temporary, 'restored');
    await manager.syncS3ToDirectory('certbot', restored);
    for (const name of names) {
      const file = path.join(restored, 'live/example.com', name + '.pem');
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(file)).toBe('../../archive/example.com/' + name + '2.pem');
      expect(fs.readFileSync(file, 'utf8')).toBe(name + ':2');
    }
    expect(fs.readFileSync(path.join(restored, 'live/example.com/README'), 'utf8')).toBe('legacy readme');
  });

  test.each(['missing-archive-file', 'mixed-generation', 'mismatched-content', 'incomplete-live'])(
    'legacy migration rejects unverifiable lineage: %s', async scenario => {
      const { manager, objects } = memoryStore();
      const names = ['cert', 'privkey', 'chain', 'fullchain'];
      for (const name of names) {
        for (const generation of [1, 2]) {
          if (scenario !== 'missing-archive-file' || name !== 'fullchain') {
            objects.set('certbot/archive/example.com/' + name + generation + '.pem', {
              body: Buffer.from(name + ':' + generation), etag: 'legacy',
            });
          }
        }
        if (scenario !== 'incomplete-live' || name === 'cert') {
          const generation = scenario === 'mixed-generation' && name === 'cert' ? 2 : 1;
          objects.set('certbot/live/example.com/' + name + '.pem', {
            body: Buffer.from(scenario === 'mismatched-content' && name === 'privkey' ? 'unknown' : name + ':' + generation),
            etag: 'legacy',
          });
        }
      }
      const restored = path.join(temporary, 'restored');
      fs.mkdirSync(restored);
      fs.writeFileSync(path.join(restored, 'existing'), 'preserved');
      await expect(manager.syncS3ToDirectory('certbot', restored)).rejects.toThrow('Legacy live state');
      expect(fs.readdirSync(restored)).toEqual(['existing']);
      expect(fs.readFileSync(path.join(restored, 'existing'), 'utf8')).toBe('preserved');
    },
  );

  test('manifest permission and parsing failures do not fall back to legacy state', async () => {
    const denied = managerWith(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); });
    await expect(denied.syncS3ToDirectory('certbot', path.join(temporary, 'denied'))).rejects.toThrow('denied');
    const { manager, objects } = memoryStore();
    objects.set('certbot/.snapshot.json', { body: Buffer.from('invalid json'), etag: 'etag' });
    await expect(manager.syncS3ToDirectory('certbot', path.join(temporary, 'invalid'))).rejects.toBeInstanceOf(SyntaxError);
  });
});
