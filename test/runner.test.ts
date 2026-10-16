import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CertbotRunner } from '../lambda/src/certbot/runner';
import { CertificateConfig, CertonlyPayload } from '../lambda/src/types/domain-config';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFileSync: jest.fn() }));
const mockExec = jest.mocked(execFileSync);
const config: CertificateConfig = {
  id: 'example', domains: ['example.com', '*.example.com'], email: 'admin@example.com',
  acmeProvider: 'letsencrypt', route53HostedZoneId: 'Z1234567890',
  acmCertificateArn: null, enabled: true, renewDaysBeforeExpiry: 30,
};

describe('Certbot issuance arguments and lineage paths', () => {
  let temporary: string;
  let runner: CertbotRunner;

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-runner-test-'));
    runner = new CertbotRunner(temporary);
    mockExec.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  function lineage(name = 'example.com'): string {
    const directory = path.join(temporary, 'config/live', name);
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['cert', 'chain', 'fullchain', 'privkey']) {
      fs.writeFileSync(path.join(directory, `${name}.pem`), `test-${name}`);
    }
    return directory;
  }

  function expectedPaths(directory: string) {
    return {
      certPath: path.join(directory, 'cert.pem'), chainPath: path.join(directory, 'chain.pem'),
      fullChainPath: path.join(directory, 'fullchain.pem'), privateKeyPath: path.join(directory, 'privkey.pem'),
    };
  }

  test.each(['example.com', 'example.com-0001'])('parses fullchain stdout for lineage %s', async name => {
    const directory = lineage(name);
    // Keep a second valid lineage present to prove the parsed path takes priority.
    lineage(name === 'example.com' ? 'example.com-0001' : 'example.com');
    mockExec.mockReturnValue(`Certificate is saved at: ${directory}/fullchain.pem\nKey is saved at: ${directory}/privkey.pem`);
    await expect(runner.obtainCertificate(config)).resolves.toEqual(expectedPaths(directory));
  });

  test.each(['example.com', 'example.com-0001'])('parses private-key stdout fallback for lineage %s', async name => {
    const directory = lineage(name);
    mockExec.mockReturnValue(`Key is saved at: ${directory}/privkey.pem`);
    await expect(runner.obtainCertificate(config)).resolves.toEqual(expectedPaths(directory));
  });

  test.each(['example.com', 'example.com-0001'])('uses local lineage %s when stdout has no path', async name => {
    const directory = lineage(name);
    mockExec.mockReturnValue('Certificate operation succeeded without an English path message');
    await expect(runner.obtainCertificate(config)).resolves.toEqual(expectedPaths(directory));
  });

  test('uses the largest numeric lineage suffix when only numbered lineages exist', async () => {
    lineage('example.com-0001');
    const newest = lineage('example.com-0010');
    lineage('example.com-0002');
    mockExec.mockReturnValue('No path to parse');
    await expect(runner.obtainCertificate(config)).resolves.toEqual(expectedPaths(newest));
  });

  test('does not treat the domain dot as a wildcard when searching fallback directories', async () => {
    lineage('exampleXcom-0001');
    mockExec.mockReturnValue('No path to parse');
    await expect(runner.obtainCertificate(config)).rejects.toMatchObject({ name: 'CertbotExecutionFailed' });
  });

  test('rejects stdout paths for a different domain even if it differs only at the dot', async () => {
    const wrong = lineage('exampleXcom');
    lineage();
    mockExec.mockReturnValue(`Certificate is saved at: ${wrong}/fullchain.pem`);
    await expect(runner.obtainCertificate(config)).rejects.toMatchObject({ name: 'CertbotExecutionFailed' });
  });

  test.each([null, 'arn:aws:acm:us-east-1:123456789012:certificate/existing'])('forces renewal only for an existing ARN: %s', async acmCertificateArn => {
    lineage();
    mockExec.mockReturnValue('No path to parse');
    await runner.obtainCertificate({ ...config, acmCertificateArn });
    const [command, args, options] = mockExec.mock.calls[0];
    expect(command).toBe('certbot');
    expect((args as string[]).includes('--force-renewal')).toBe(!!acmCertificateArn);
    expect(args).toEqual(expect.arrayContaining([
      '--cert-name', 'example.com', '-d', 'example.com', '-d', '*.example.com',
      '--dns-route53', '--preferred-challenges', 'dns-01',
    ]));
    expect(options).toEqual(expect.objectContaining({ stdio: 'pipe', encoding: 'utf-8' }));
  });

  test.each([
    { keyType: undefined, rsaKeySize: undefined, expectedType: 'rsa', expectedSize: '2048' },
    { keyType: 'rsa' as const, rsaKeySize: 4096 as const, expectedType: 'rsa', expectedSize: '4096' },
    { keyType: 'ecdsa' as const, rsaKeySize: 4096 as const, expectedType: 'ecdsa', expectedSize: undefined },
  ])('uses compatible key arguments: $expectedType / $expectedSize', async settings => {
    lineage();
    mockExec.mockReturnValue('No path to parse');
    await runner.obtainCertificate({ ...config, keyType: settings.keyType, rsaKeySize: settings.rsaKeySize });
    const args = mockExec.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--key-type') + 1]).toBe(settings.expectedType);
    if (settings.expectedSize) expect(args[args.indexOf('--rsa-key-size') + 1]).toBe(settings.expectedSize);
    else expect(args).not.toContain('--rsa-key-size');
  });

  test.each([false, true])('certonly honors the explicit forceRenewal option: %s', async forceRenewal => {
    const directory = lineage('example.com-0001');
    mockExec.mockReturnValue(`Certificate is saved at: ${directory}/fullchain.pem`);
    const payload: CertonlyPayload = { input: {
      mode: 'certonly', domains: config.domains, email: config.email,
      server: 'https://acme.example.com/directory', route53HostedZoneId: config.route53HostedZoneId,
      forceRenewal, keyType: 'ecdsa',
    } };
    await expect(runner.obtainCertificateFromPayload(payload)).resolves.toEqual(expectedPaths(directory));
    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.includes('--force-renewal')).toBe(forceRenewal);
    expect(args[args.indexOf('--server') + 1]).toBe(payload.input.server);
    expect(args).not.toContain('--rsa-key-size');
  });
});
