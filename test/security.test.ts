import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspect } from 'util';
import { execFileSync } from 'child_process';
import { SNSClient } from '../lambda/node_modules/@aws-sdk/client-sns';
import { handler } from '../lambda/src';
import { CertbotRunner } from '../lambda/src/certbot/runner';
import { Notifier } from '../lambda/src/notification/notifier';
import { S3Manager } from '../lambda/src/storage/s3-manager';
import { CertificateManager } from '../lambda/src/acm/certificate-manager';
import { CertificateConfig, CertonlyPayload, RegisterPayload } from '../lambda/src/types/domain-config';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFileSync: jest.fn() }));

// These values are deliberately fake. Test both fields independently at every output boundary.
const kid = 'DUMMY_EAB_KID_DO_NOT_LOG_1039';
const hmac = 'DUMMY_EAB_HMAC_DO_NOT_LOG_7250';
const registration: RegisterPayload = { input: {
  mode: 'register', email: 'admin@example.com', server: 'https://acme.example.com/directory',
  eabKid: kid, eabHmacKey: hmac,
} };
const certonly: CertonlyPayload = { input: {
  mode: 'certonly', email: 'admin@example.com', server: 'https://acme.example.com/directory',
  domains: ['example.com'], route53HostedZoneId: 'Z1234567890',
} };
const certificate: CertificateConfig = {
  id: 'example', domains: ['example.com'], email: 'admin@example.com', acmeProvider: 'letsencrypt',
  route53HostedZoneId: 'Z1234567890', acmCertificateArn: null, enabled: true, renewDaysBeforeExpiry: 30,
};
const mockExec = jest.mocked(execFileSync);

function contaminatedError(name = kid): Error {
  return Object.assign(new Error(`Command failed --eab-kid ${kid} --eab-hmac-key ${hmac}`), {
    name, stack: `trace ${kid} ${hmac}`, stdout: Buffer.from(`${kid} ${hmac}`),
    stderr: `${hmac} ${kid}`, command: `${kid} ${hmac}`, nested: { eabHmacKey: hmac },
  });
}

describe('EAB output boundary regression', () => {
  let temporary: string;
  let logs: jest.SpyInstance[];
  let publish: jest.SpyInstance;
  const environment = { ...process.env };

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-security-test-'));
    logs = ['log', 'error', 'warn', 'info', 'debug'].map(method =>
      jest.spyOn(console, method as 'log').mockImplementation(() => {}));
    publish = jest.spyOn(SNSClient.prototype, 'send').mockImplementation((async () => ({ MessageId: 'test' })) as any);
    mockExec.mockReset();
    process.env.CERTIFICATE_BUCKET = 'security-test-bucket';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:security-test';
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(temporary, { recursive: true, force: true });
    process.env = { ...environment };
  });

  function assertNoSecrets(...results: unknown[]): void {
    const observable = inspect({
      logs: logs.map(log => log.mock.calls),
      sns: publish.mock.calls.map(([command]) => command.input),
      results,
    }, { depth: 20 });
    expect(observable).not.toContain(kid);
    expect(observable).not.toContain(hmac);
  }

  function certificateFiles(): string {
    const live = path.join(temporary, 'config/live/example.com');
    fs.mkdirSync(live, { recursive: true });
    for (const name of ['cert', 'chain', 'fullchain', 'privkey']) {
      fs.writeFileSync(path.join(live, `${name}.pem`), `test-${name}`);
    }
    return live;
  }

  function mockHandlerStorage() {
    jest.spyOn(CertbotRunner.prototype, 'initialize').mockImplementation(() => {});
    const cleanup = jest.spyOn(CertbotRunner.prototype, 'cleanup').mockImplementation(() => {});
    const acquire = jest.spyOn(S3Manager.prototype, 'acquireLock')
      .mockResolvedValue({ key: 'locks/certbot.json', owner: 'test-owner', etag: 'test-etag' });
    const release = jest.spyOn(S3Manager.prototype, 'releaseLock').mockResolvedValue(undefined);
    const restore = jest.spyOn(S3Manager.prototype, 'syncS3ToDirectory').mockResolvedValue(undefined);
    const upload = jest.spyOn(S3Manager.prototype, 'syncDirectoryToS3').mockResolvedValue(undefined);
    const config = jest.spyOn(S3Manager.prototype, 'downloadConfigVersioned').mockResolvedValue({
      content: JSON.stringify({ version: '1.0', certificates: [certificate] }), etag: 'config-etag',
    });
    jest.spyOn(S3Manager.prototype, 'saveCertificateBackup').mockResolvedValue(undefined);
    jest.spyOn(S3Manager.prototype, 'uploadConfig').mockResolvedValue('written-etag');
    jest.spyOn(CertificateManager.prototype, 'importCertificate')
      .mockResolvedValue('arn:aws:acm:us-east-1:123456789012:certificate/test');
    return { cleanup, acquire, release, restore, upload, config };
  }

  test('registration success captures stdout without logging credentials or subprocess options', async () => {
    mockExec.mockReturnValue(`${kid}\n${hmac}`);
    await new CertbotRunner(temporary).registerAccount(registration);
    expect(mockExec).toHaveBeenCalledWith('certbot', expect.arrayContaining([
      '--eab-kid', kid, '--eab-hmac-key', hmac,
    ]), expect.objectContaining({ stdio: 'pipe' }));
    assertNoSecrets();
  });

  test.each(['register', 'certonly', 'renew'] as const)('runner %s failures discard all raw exception fields', async mode => {
    mockExec.mockImplementation(() => { throw contaminatedError(); });
    const runner = new CertbotRunner(temporary);
    const operation = mode === 'register' ? runner.registerAccount(registration)
      : mode === 'certonly' ? runner.obtainCertificateFromPayload(certonly) : runner.obtainCertificate(certificate);
    let caught: unknown;
    try { await operation; } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: mode === 'register' ? 'CertbotRegistrationFailed' : 'CertbotExecutionFailed' });
    assertNoSecrets(caught);
  });

  test.each(['certonly', 'renew'] as const)('runner %s parses valid paths while suppressing unrelated stdout', async mode => {
    const live = certificateFiles();
    mockExec.mockReturnValue(`${kid}\nCertificate is saved at: ${live}/fullchain.pem\n${hmac}`);
    const runner = new CertbotRunner(temporary);
    const result = mode === 'certonly' ? await runner.obtainCertificateFromPayload(certonly)
      : await runner.obtainCertificate(certificate);
    expect(result.certPath).toBe(path.join(live, 'cert.pem'));
    assertNoSecrets(result);
  });

  test.each([false, true])('stdout paths cannot inject credentials into diagnostics or results (existing path=%s)', async exists => {
    certificateFiles();
    const injected = path.join(temporary, kid, hmac);
    if (exists) {
      fs.mkdirSync(injected, { recursive: true });
      for (const name of ['cert', 'chain', 'fullchain', 'privkey']) {
        fs.writeFileSync(path.join(injected, `${name}.pem`), 'untrusted');
      }
    }
    mockExec.mockReturnValue(`Certificate is saved at: ${injected}/fullchain.pem`);
    const result = await new CertbotRunner(temporary).obtainCertificateFromPayload(certonly).catch(error => error);
    assertNoSecrets(result);
  });

  test('notifier publishes an allowlisted error code rather than Error message, stack, or properties', async () => {
    await new Notifier(process.env.SNS_TOPIC_ARN!).sendError(contaminatedError(), 'Certificate management');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].input.Message).toContain('Code: OperationFailed');
    assertNoSecrets();
  });

  test('notifier preserves known error codes and discards contaminated error fields in summaries', async () => {
    const notifier = new Notifier(process.env.SNS_TOPIC_ARN!);
    await notifier.sendError(contaminatedError('AccessDenied'), 'Certificate management');
    await notifier.sendRenewalSummary([{
      certificateId: 'example', domains: ['example.com'], success: false,
      error: `${kid} ${hmac}`, ...{ debug: contaminatedError() },
    }]);
    expect(publish.mock.calls[0][0].input.Message).toContain('Code: AccessDenied');
    expect(publish.mock.calls[1][0].input.Message).toContain('Error: OperationFailed');
    assertNoSecrets();
  });

  test('SNS transport errors cannot expose their own message, stack, stdout, or arbitrary fields', async () => {
    publish.mockRejectedValue(contaminatedError());
    await new Notifier(process.env.SNS_TOPIC_ARN!).sendError(contaminatedError(), 'Certificate management');
    assertNoSecrets();
  });

  test.each([false, true])('handler registration success/failure uses the actual runner and notifier (failure=%s)', async fails => {
    const storage = mockHandlerStorage();
    mockExec.mockImplementation(() => {
      if (fails) throw contaminatedError();
      return `${kid}\n${hmac}`;
    });
    const result = await handler({ ...registration, arbitrary: { key: hmac } } as any);
    expect(result.statusCode).toBe(fails ? 500 : 200);
    expect(storage.release).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    assertNoSecrets(result);
  });

  test('invalid input containing credentials is rejected without echoing the event', async () => {
    const result = await handler({ input: { mode: kid, eabHmacKey: hmac } } as any);
    expect(result.statusCode).toBe(500);
    expect(mockExec).not.toHaveBeenCalled();
    assertNoSecrets(result);
  });

  test.each(['acquire', 'restore', 'upload', 'release'] as const)('handler %s errors never expose raw SDK exceptions', async stage => {
    const storage = mockHandlerStorage();
    storage[stage].mockRejectedValue(contaminatedError());
    mockExec.mockReturnValue(`${kid} ${hmac}`);
    const result = await handler(registration);
    expect(publish).toHaveBeenCalled();
    assertNoSecrets(result);
  });

  test('per-certificate renew failure produces a failed HTTP result and a sanitized summary', async () => {
    mockHandlerStorage();
    mockExec.mockImplementation(() => { throw contaminatedError(); });
    const result = await handler({ input: { mode: 'renew' } });
    expect(result.statusCode).toBe(500);
    expect(result.body.totalFailed).toBe(1);
    expect(result.body.results[0].error).toBe('CertbotExecutionFailed');
    expect(publish.mock.calls[0][0].input.Subject).toContain('[FAILURE]');
    assertNoSecrets(result);
  });

  test('cleanup diagnostics discard raw filesystem exceptions', () => {
    fs.mkdirSync(path.join(temporary, 'state'));
    jest.spyOn(fs, 'rmSync').mockImplementation(() => { throw contaminatedError(); });
    try { new CertbotRunner(path.join(temporary, 'state')).cleanup(); } catch { /* strict cleanup may reject */ }
    assertNoSecrets();
  });

  test('an initial cleanup failure stops registration before reusing stale Certbot state', async () => {
    const storage = mockHandlerStorage();
    storage.cleanup.mockRestore();
    const exists = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation(target => target === '/tmp/certbot' || exists(target));
    jest.spyOn(fs, 'rmSync').mockImplementation(() => { throw contaminatedError(); });
    mockExec.mockReturnValue('Account registered');
    const result = await handler(registration);
    expect(result.statusCode).toBe(500);
    expect(mockExec).not.toHaveBeenCalled();
    expect(storage.release).toHaveBeenCalledTimes(1);
    assertNoSecrets(result);
  });
});
