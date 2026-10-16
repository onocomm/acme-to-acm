import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { S3Client } from '../lambda/node_modules/@aws-sdk/client-s3';
import { handler } from '../lambda/src/index';
import { S3Manager } from '../lambda/src/storage/s3-manager';
import { CertbotRunner } from '../lambda/src/certbot/runner';
import { CertificateManager } from '../lambda/src/acm/certificate-manager';
import { Notifier } from '../lambda/src/notification/notifier';
import { CertificateConfig, CertbotCertificatePaths } from '../lambda/src/types/domain-config';

type Command = { constructor: { name: string }; input: Record<string, any> };
type ObjectData = { body: Buffer; etag: string; metadata?: Record<string, string> };
const pemNames = ['cert', 'privkey', 'chain', 'fullchain'];

function certificatePaths(configDir: string, domain: string): CertbotCertificatePaths {
  const live = path.join(configDir, 'live', domain);
  return {
    certPath: path.join(live, 'cert.pem'),
    privateKeyPath: path.join(live, 'privkey.pem'),
    chainPath: path.join(live, 'chain.pem'),
    fullChainPath: path.join(live, 'fullchain.pem'),
  };
}

function writeGeneration(configDir: string, domain: string, generation: number): void {
  const archive = path.join(configDir, 'archive', domain);
  const live = path.join(configDir, 'live', domain);
  fs.mkdirSync(archive, { recursive: true });
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'renewal'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'renewal', domain + '.conf'), 'renewal configuration for ' + domain);
  for (const pem of pemNames) {
    fs.writeFileSync(path.join(archive, pem + generation + '.pem'), domain + ':' + pem + ':' + generation);
    const link = path.join(live, pem + '.pem');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.symlinkSync('../../archive/' + domain + '/' + pem + generation + '.pem', link);
  }
}

function expectGeneration(configDir: string, domain: string, generation: number): void {
  for (const pem of pemNames) {
    const live = path.join(configDir, 'live', domain, pem + '.pem');
    expect(fs.lstatSync(live).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(live)).toBe('../../archive/' + domain + '/' + pem + generation + '.pem');
    expect(fs.readFileSync(live, 'utf8')).toBe(domain + ':' + pem + ':' + generation);
  }
}

describe('renew handler with restored multi-certificate S3 state', () => {
  let temporary: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-renew-integration-'));
    originalEnv = { ...process.env };
    process.env.CERTIFICATE_BUCKET = 'integration-certificate-bucket';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:integration';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DOMAIN_CONFIG_KEY = 'config/domains.json';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  test('restores two lineages, reuses both ACM ARNs, and saves both renewed lineages and live links', async () => {
    const objects = new Map<string, ObjectData>();
    let revision = 0;
    const send = jest.spyOn(S3Client.prototype, 'send');
    send.mockImplementation((async (command: Command) => {
      const input = command.input;
      const key = input.Key as string;
      const current = objects.get(key);
      switch (command.constructor.name) {
        case 'GetObjectCommand':
          if (!current) throw Object.assign(new Error('missing fixture object'), { name: 'NoSuchKey' });
          return { Body: Readable.from([current.body]), ETag: current.etag, Metadata: current.metadata };
        case 'PutObjectCommand': {
          if ((input.IfNoneMatch === '*' && current) || (input.IfMatch && input.IfMatch !== current?.etag)) {
            throw Object.assign(new Error('fixture precondition failed'), { name: 'PreconditionFailed' });
          }
          const etag = '"integration-' + ++revision + '"';
          objects.set(key, { body: Buffer.from(input.Body), etag, metadata: input.Metadata });
          return { ETag: etag };
        }
        case 'ListObjectsV2Command': {
          const keys = [...objects.keys()].filter(key => key.startsWith(input.Prefix)).sort();
          const start = Number(input.ContinuationToken ?? 0);
          const end = start + 3;
          return {
            Contents: keys.slice(start, end).map(Key => ({ Key })),
            IsTruncated: end < keys.length,
            ...(end < keys.length ? { NextContinuationToken: String(end) } : {}),
          };
        }
        case 'DeleteObjectCommand':
          if (input.IfMatch && current?.etag !== input.IfMatch) {
            throw Object.assign(new Error('fixture delete conflict'), { name: 'PreconditionFailed' });
          }
          objects.delete(key);
          return {};
        default: throw new Error('Unexpected AWS command in integration test');
      }
    }) as any);

    const certificates: CertificateConfig[] = ['one.example.com', 'two.example.com'].map((domain, index) => ({
      id: 'certificate-' + (index + 1), domains: [domain], email: 'admin@example.com',
      acmeProvider: 'letsencrypt', route53HostedZoneId: 'ZINTEGRATION', enabled: true,
      renewDaysBeforeExpiry: 30,
      acmCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/existing-' + (index + 1),
    }));
    const storage = new S3Manager(process.env.CERTIFICATE_BUCKET!);
    await storage.uploadConfig('config/domains.json', JSON.stringify({ version: '1.0', certificates }));
    const initialState = path.join(temporary, 'initial');
    for (const cert of certificates) writeGeneration(initialState, cert.domains[0], 1);
    await storage.syncDirectoryToS3(initialState, 'certbot');
    fs.rmSync(initialState, { recursive: true });

    const runtimeState = path.join(temporary, 'runtime/config');
    jest.spyOn(CertbotRunner.prototype, 'getConfigDir').mockReturnValue(runtimeState);
    jest.spyOn(CertbotRunner.prototype, 'initialize').mockImplementation(() => {});
    const cleanup = jest.spyOn(CertbotRunner.prototype, 'cleanup').mockImplementation(() => {});
    const issued = new Set<string>();
    const obtain = jest.spyOn(CertbotRunner.prototype, 'obtainCertificate').mockImplementation(async cert => {
      // 発行処理の入口で2件とも復元済みであり、先に更新した証明書も保持されている。
      for (const candidate of certificates) {
        expectGeneration(runtimeState, candidate.domains[0], issued.has(candidate.id) ? 2 : 1);
      }
      writeGeneration(runtimeState, cert.domains[0], 2);
      issued.add(cert.id);
      return certificatePaths(runtimeState, cert.domains[0]);
    });
    const needsRenewal = jest.spyOn(CertificateManager.prototype, 'needsRenewal').mockResolvedValue(true);
    const importCertificate = jest.spyOn(CertificateManager.prototype, 'importCertificate').mockImplementation(async (paths, id, arn) => {
      const expected = certificates.find(cert => cert.id === id)!;
      expect(arn).toBe(expected.acmCertificateArn);
      expect(fs.readFileSync(paths.certPath, 'utf8')).toBe(expected.domains[0] + ':cert:2');
      return arn!;
    });
    const summary = jest.spyOn(Notifier.prototype, 'sendRenewalSummary').mockResolvedValue();
    jest.spyOn(Notifier.prototype, 'sendSuccess').mockResolvedValue();
    const notifyError = jest.spyOn(Notifier.prototype, 'sendError').mockResolvedValue();

    const result = await handler({ input: { mode: 'renew' } });

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ totalProcessed: 2, totalSuccess: 2, totalFailed: 0, totalSkipped: 0 });
    expect(result.body.results.map(item => item.acmCertificateArn)).toEqual(certificates.map(cert => cert.acmCertificateArn));
    expect(obtain).toHaveBeenCalledTimes(2);
    expect(needsRenewal.mock.calls).toEqual(certificates.map(cert => [cert.acmCertificateArn, 30]));
    expect(importCertificate.mock.calls.map(([, id, arn]) => [id, arn])).toEqual(certificates.map(cert => [cert.id, cert.acmCertificateArn]));
    expect(summary).toHaveBeenCalledTimes(1);
    expect(notifyError).not.toHaveBeenCalled();
    expect(cleanup.mock.calls).toEqual([[true], []]);
    expect(objects.has('locks/certbot.json')).toBe(false);
    expect(JSON.parse(await storage.downloadConfig('config/domains.json')).certificates).toEqual(certificates);
    expect([...objects.keys()].filter(key => key.startsWith('certificates/')).length).toBe(8);

    // 実行ディレクトリを破棄し、保存済みS3状態だけから再び復元して永続化を検証する。
    fs.rmSync(path.dirname(runtimeState), { recursive: true });
    const verificationState = path.join(temporary, 'verification');
    await storage.syncS3ToDirectory('certbot', verificationState);
    for (const cert of certificates) {
      expectGeneration(verificationState, cert.domains[0], 2);
      expect(fs.readFileSync(path.join(verificationState, 'archive', cert.domains[0], 'cert1.pem'), 'utf8')).toBe(cert.domains[0] + ':cert:1');
      expect(fs.existsSync(path.join(verificationState, 'renewal', cert.domains[0] + '.conf'))).toBe(true);
    }
    expect(fs.readdirSync(path.join(verificationState, 'live')).sort()).toEqual(certificates.map(cert => cert.domains[0]).sort());
    const manifest = JSON.parse(await storage.downloadConfig('certbot/.snapshot.json'));
    expect([...objects.entries()].filter(([key, value]) => key.startsWith(manifest.prefix) && value.metadata?.['entry-type'] === 'symlink')).toHaveLength(8);
  });
});
