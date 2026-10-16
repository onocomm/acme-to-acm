import { handler } from '../lambda/src/index';
import { S3Manager } from '../lambda/src/storage/s3-manager';
import { CertbotRunner } from '../lambda/src/certbot/runner';
import { CertificateManager } from '../lambda/src/acm/certificate-manager';
import { Notifier } from '../lambda/src/notification/notifier';
import { parseConfiguration } from '../lambda/src/configuration';

jest.mock('../lambda/src/storage/s3-manager');
jest.mock('../lambda/src/certbot/runner');
jest.mock('../lambda/src/acm/certificate-manager');
jest.mock('../lambda/src/notification/notifier');

const s3 = S3Manager.prototype as jest.Mocked<S3Manager>;
const runner = CertbotRunner.prototype as jest.Mocked<CertbotRunner>;
const acm = CertificateManager.prototype as jest.Mocked<CertificateManager>;
const notifier = Notifier.prototype as jest.Mocked<Notifier>;
const cert = (id = 'existing', domain = 'example.com', arn: string | null = 'arn:existing') => ({
  id, domains: [domain], email: 'admin@example.com', acmeProvider: 'custom' as const,
  acmeServerUrl: 'https://acme.example.com/directory', route53HostedZoneId: 'Z123',
  acmCertificateArn: arn, renewDaysBeforeExpiry: 45, enabled: true,
});
const payload = { input: { mode: 'certonly' as const, domains: ['example.com'],
  email: 'admin@example.com', server: 'https://acme.example.com/directory', route53HostedZoneId: 'Z123' } };
const namedError = (name: string) => Object.assign(new Error('sensitive untrusted message'), { name });
let document: ReturnType<typeof parseConfiguration>;

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  process.env.CERTIFICATE_BUCKET = 'test-bucket';
  process.env.SNS_TOPIC_ARN = 'arn:test';
  document = { version: '1.0', certificates: [cert(), cert('other', 'other.example.com', 'arn:other')] };
  s3.acquireLock.mockResolvedValue({ key: 'locks/certbot.json', etag: 'lock', owner: 'owner' });
  s3.downloadConfigVersioned.mockImplementation(async () => ({ content: JSON.stringify(document), etag: 'v1' }));
  s3.uploadConfig.mockImplementation(async (_key, content) => { document = JSON.parse(content); return 'v2'; });
  runner.obtainCertificateFromPayload.mockResolvedValue({ certPath: '/cert', chainPath: '/chain',
    fullChainPath: '/fullchain', privateKeyPath: '/key' });
  runner.obtainCertificate.mockResolvedValue({ certPath: '/cert', chainPath: '/chain',
    fullChainPath: '/fullchain', privateKeyPath: '/key' });
  acm.importCertificate.mockImplementation(async (_paths, _id, arn) => arn || 'arn:new');
  acm.needsRenewal.mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

test.each(['AccessDenied', 'NetworkingError', 'NoSuchBucket'])('取得失敗 %s は設定を変更せず発行前に停止する', async name => {
  s3.downloadConfigVersioned.mockRejectedValue(namedError(name));
  const result = await handler(payload);
  expect(result.statusCode).toBe(500);
  expect(runner.obtainCertificateFromPayload).not.toHaveBeenCalled();
  expect(s3.uploadConfig).not.toHaveBeenCalled();
  expect(acm.importCertificate).not.toHaveBeenCalled();
  expect(s3.releaseLock).toHaveBeenCalledTimes(1);
});

test.each(['{broken', '{"version":"1.0"}', '{"version":"1.0","certificates":[{}]}'])('不正設定では空設定へ置換しない: %s', async content => {
  s3.downloadConfigVersioned.mockResolvedValue({ content, etag: 'v1' });
  expect((await handler(payload)).body.message).toBe('InvalidConfiguration');
  expect(runner.obtainCertificateFromPayload).not.toHaveBeenCalled();
  expect(s3.uploadConfig).not.toHaveBeenCalled();
});

test('NoSuchKeyだけを初回作成として扱う', async () => {
  s3.downloadConfigVersioned.mockRejectedValue(namedError('NoSuchKey'));
  expect((await handler(payload)).statusCode).toBe(200);
  expect(s3.uploadConfig).toHaveBeenCalledWith('config/domains.json', expect.any(String), undefined);
  expect(document.certificates).toHaveLength(1);
});

test('再実行時は既存ID・ARN・他証明書・運用設定を保持してupsertする', async () => {
  for (let i = 0; i < 2; i++) expect((await handler(payload)).statusCode).toBe(200);
  expect(document.certificates).toHaveLength(2);
  expect(document.certificates[0]).toMatchObject({ id: 'existing', acmCertificateArn: 'arn:existing', renewDaysBeforeExpiry: 45 });
  expect(document.certificates[1]).toEqual(cert('other', 'other.example.com', 'arn:other'));
  expect(acm.importCertificate).toHaveBeenCalledWith(expect.anything(), 'existing', 'arn:existing');
  expect(s3.uploadConfig).toHaveBeenCalledWith('config/domains.json', expect.any(String), 'v1');
});

test('既存ARNの明示的な別ARNへの置換を停止する', async () => {
  expect((await handler({ input: { ...payload.input, acmCertificateArn: 'arn:different' } })).statusCode).toBe(500);
  expect(acm.importCertificate).not.toHaveBeenCalled();
});

test('ETag競合を成功扱いせず、無条件リトライしない', async () => {
  s3.uploadConfig.mockRejectedValue(namedError('PreconditionFailed'));
  const result = await handler(payload);
  expect(result.statusCode).toBe(500);
  expect(result.body.message).toBe('PreconditionFailed');
  expect(s3.uploadConfig).toHaveBeenCalledTimes(1);
  expect(notifier.sendSuccess).not.toHaveBeenCalled();
});

test('ロック競合時はローカル状態とS3状態を変更しない', async () => {
  s3.acquireLock.mockRejectedValue(namedError('LockConflictError'));
  expect((await handler(payload)).statusCode).toBe(500);
  expect(runner.initialize).not.toHaveBeenCalled();
  expect(s3.syncS3ToDirectory).not.toHaveBeenCalled();
  expect(s3.releaseLock).not.toHaveBeenCalled();
});

test('更新の個別失敗を500にし、他証明書は継続する', async () => {
  runner.obtainCertificate.mockRejectedValueOnce(namedError('CertbotExecutionFailed'));
  const result = await handler({ input: { mode: 'renew' } });
  expect(result.statusCode).toBe(500);
  expect(result.body).toMatchObject({ totalSuccess: 1, totalFailed: 1, totalSkipped: 0 });
  expect(result.body.results[0].error).toBe('CertbotExecutionFailed');
  expect(acm.importCertificate).toHaveBeenCalledWith(expect.anything(), 'other', 'arn:other');
});

test('renew初回発行で得たARNも条件付きで保存する', async () => {
  document.certificates[0].acmCertificateArn = null as any;
  const result = await handler({ input: { mode: 'renew' } });
  expect(result.statusCode).toBe(200);
  expect(document.certificates[0].acmCertificateArn).toBe('arn:new');
  expect(document.certificates[1].acmCertificateArn).toBe('arn:other');
  expect(s3.uploadConfig).toHaveBeenCalledTimes(1);
});

test('連続したARN保存は自分の書込ETagだけを次の条件に使う', async () => {
  document.certificates.forEach(c => { c.acmCertificateArn = null; });
  s3.uploadConfig.mockResolvedValueOnce('own-write-1').mockResolvedValueOnce('own-write-2');
  expect((await handler({ input: { mode: 'renew' } })).statusCode).toBe(200);
  expect(s3.downloadConfigVersioned).toHaveBeenCalledTimes(1);
  expect(s3.uploadConfig.mock.calls.map(call => call[2])).toEqual(['v1', 'own-write-1']);
});

test('dryRunは発行をせず、同期と通知を行い成功件数に含めない', async () => {
  const result = await handler({ input: { mode: 'renew', dryRun: true } });
  expect(result.statusCode).toBe(200);
  expect(result.body).toMatchObject({ totalSuccess: 0, totalSkipped: 2, totalFailed: 0 });
  expect(runner.obtainCertificate).not.toHaveBeenCalled();
  expect(acm.importCertificate).not.toHaveBeenCalled();
  expect(s3.syncDirectoryToS3).toHaveBeenCalled();
  expect(notifier.sendRenewalSummary).toHaveBeenCalled();
});

test('不正イベントの入力値を応答へ反映しない', async () => {
  const result = await handler({ input: { mode: 'DUMMY_SECRET' } } as any);
  expect(JSON.stringify(result)).not.toContain('DUMMY_SECRET');
  expect(result.body.message).toBe('InvalidInput');
});
