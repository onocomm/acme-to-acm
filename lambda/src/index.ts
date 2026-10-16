/**
 * バケット共通ロックと条件付き書込で全モードの状態を保護する。
 * 外部エラーの message / stack は公開しない。
 */
import { DomainConfiguration, CertificateConfig, LambdaEvent, LambdaResponse, RenewalResult, CertonlyPayload, RegisterPayload } from './types/domain-config';
import { S3Manager } from './storage/s3-manager';
import { Notifier } from './notification/notifier';
import { CertbotRunner } from './certbot/runner';
import { CertificateManager } from './acm/certificate-manager';
import { errorCode, failure } from './diagnostics';
import { parseConfiguration, findCertificate, validDomains, validServer } from './configuration';

function response(message: string, results: RenewalResult[] = [], failed = false): LambdaResponse {
  const totalFailed = results.filter(r => !r.success && !r.skipped).length;
  return { statusCode: failed || totalFailed > 0 ? 500 : 200, body: {
    message, results, totalProcessed: results.length,
    totalSuccess: results.filter(r => r.success && !r.skipped).length,
    totalFailed: failed ? Math.max(1, totalFailed) : totalFailed,
    totalSkipped: results.filter(r => r.skipped).length,
  } };
}

function validateEvent(event: LambdaEvent): void {
  if (!event?.input || !['register', 'certonly', 'renew'].includes(event.input.mode)) throw failure('InvalidInput');
  const input = event.input;
  if (input.mode === 'renew') {
    if ((input.dryRun !== undefined && typeof input.dryRun !== 'boolean') ||
      (input.certificateIds !== undefined && (!Array.isArray(input.certificateIds) ||
        input.certificateIds.some(id => typeof id !== 'string')))) throw failure('InvalidInput');
    return;
  }
  if (typeof input.email !== 'string' || !input.email || !validServer(input.server)) throw failure('InvalidInput');
  if (input.mode === 'register') {
    if (typeof input.eabKid !== 'string' || !input.eabKid || typeof input.eabHmacKey !== 'string' ||
      !input.eabHmacKey) throw failure('InvalidInput');
  } else if (!validDomains(input.domains) || typeof input.route53HostedZoneId !== 'string' ||
    !input.route53HostedZoneId || (input.keyType !== undefined && !['rsa', 'ecdsa'].includes(input.keyType)) ||
    (input.rsaKeySize !== undefined && ![2048, 4096].includes(input.rsaKeySize)) ||
    (input.acmCertificateArn !== undefined && input.acmCertificateArn !== null &&
      typeof input.acmCertificateArn !== 'string')) throw failure('InvalidInput');
}

export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
  let s3: S3Manager | undefined;
  let notifier: Notifier | undefined;
  let runner: CertbotRunner | undefined;
  let lock: Awaited<ReturnType<S3Manager['acquireLock']>> | undefined;
  try {
    validateEvent(event);
    if (!process.env.CERTIFICATE_BUCKET || !process.env.SNS_TOPIC_ARN) throw failure('InvalidConfiguration');
    console.log('Certificate management started', { mode: event.input.mode });
    s3 = new S3Manager(process.env.CERTIFICATE_BUCKET, process.env.AWS_REGION);
    notifier = new Notifier(process.env.SNS_TOPIC_ARN, process.env.AWS_REGION);
    lock = await s3.acquireLock(960);
    runner = new CertbotRunner();
    runner.cleanup(true);
    runner.initialize();
    if (event.input.mode === 'register') {
      await s3.syncS3ToDirectory('certbot', runner.getConfigDir());
      await runner.registerAccount(event as RegisterPayload);
      await s3.syncDirectoryToS3(runner.getConfigDir(), 'certbot');
      await notifier.sendSuccess('ACME account registered successfully');
      const result = response('ACME account registered successfully');
      result.body.totalSuccess = 1;
      return result;
    }
    const acm = new CertificateManager(process.env.AWS_REGION);
    if (event.input.mode === 'certonly') return await handleCertonlyMode(event as CertonlyPayload, s3, notifier, runner, acm);
    return await handleRenewMode(event.input, s3, notifier, runner, acm);
  } catch (error) {
    const code = errorCode(error);
    console.error('Certificate management failed', { code });
    if (notifier) await notifier.sendError(failure(code), 'Certificate management');
    return response(code, [], true);
  } finally {
    runner?.cleanup();
    if (s3 && lock) {
      try { await s3.releaseLock(lock); }
      catch (error) {
        console.error('State lock release failed', { code: errorCode(error) });
        if (notifier) await notifier.sendError(failure(errorCode(error)), 'State lock release');
      }
    }
  }
};

async function handleCertonlyMode(
  event: CertonlyPayload, s3: S3Manager, notifier: Notifier, runner: CertbotRunner, acm: CertificateManager,
): Promise<LambdaResponse> {
  const key = process.env.DOMAIN_CONFIG_KEY || 'config/domains.json';
  let config: DomainConfiguration;
  let etag: string | undefined;
  try {
    const stored = await s3.downloadConfigVersioned(key);
    config = parseConfiguration(stored.content);
    etag = stored.etag;
  } catch (error) {
    if (errorCode(error) !== 'NoSuchKey') throw error;
    config = { version: '1.0', certificates: [] };
  }
  const { id, existing } = findCertificate(config, event.input);
  const explicitArn = event.input.acmCertificateArn;
  if (existing?.acmCertificateArn && explicitArn && explicitArn !== existing.acmCertificateArn) throw failure('InvalidInput');
  await s3.syncS3ToDirectory('certbot', runner.getConfigDir());
  const paths = await runner.obtainCertificateFromPayload({ input: {
    ...event.input,
    keyType: event.input.keyType || existing?.keyType || 'rsa',
    rsaKeySize: event.input.rsaKeySize ?? existing?.rsaKeySize,
  } });
  await s3.syncDirectoryToS3(runner.getConfigDir(), 'certbot');
  await s3.saveCertificateBackup(id, paths.certPath, paths.privateKeyPath, paths.chainPath, paths.fullChainPath);
  const arn = await acm.importCertificate(paths, id, existing?.acmCertificateArn || explicitArn || null);
  const newConfig: CertificateConfig = {
    ...existing, id, domains: event.input.domains, email: event.input.email,
    acmeProvider: 'custom', acmeServerUrl: event.input.server,
    route53HostedZoneId: event.input.route53HostedZoneId, acmCertificateArn: arn,
    renewDaysBeforeExpiry: existing?.renewDaysBeforeExpiry ?? 30,
    enabled: existing?.enabled ?? true, keyType: event.input.keyType || existing?.keyType || 'rsa',
    rsaKeySize: event.input.rsaKeySize ?? existing?.rsaKeySize,
  };
  if (existing) config.certificates[config.certificates.indexOf(existing)] = newConfig;
  else config.certificates.push(newConfig);
  await s3.uploadConfig(key, JSON.stringify(config, null, 2), etag);
  await notifier.sendSuccess('Certificate obtained, imported, and configuration saved successfully');
  return response('Certificate obtained and imported successfully', [{
    certificateId: id, domains: event.input.domains, success: true, acmCertificateArn: arn,
    expiryDate: await getExpiry(acm, arn),
  }]);
}

async function handleRenewMode(
  input: { certificateIds?: string[]; dryRun?: boolean }, s3: S3Manager,
  notifier: Notifier, runner: CertbotRunner, acm: CertificateManager,
): Promise<LambdaResponse> {
  const key = process.env.DOMAIN_CONFIG_KEY || 'config/domains.json';
  const stored = await s3.downloadConfigVersioned(key);
  const config = parseConfiguration(stored.content);
  let etag = stored.etag;
  const results: RenewalResult[] = [];
  await s3.syncS3ToDirectory('certbot', runner.getConfigDir());
  for (const cert of config.certificates) {
    if (input.certificateIds && !input.certificateIds.includes(cert.id)) continue;
    if (!cert.enabled) {
      results.push({ certificateId: cert.id, domains: cert.domains, success: false,
        skipped: true, skipReason: 'Certificate is disabled in configuration' });
      continue;
    }
    const result = await processCertificate(cert, s3, runner, acm, input.dryRun || false);
    results.push(result);
    if (result.success && !result.skipped && result.acmCertificateArn !== cert.acmCertificateArn) {
      cert.acmCertificateArn = result.acmCertificateArn!;
      etag = await s3.uploadConfig(key, JSON.stringify(config, null, 2), etag);
    }
  }
  // dryRun もS3同期と通知を行う。発行試験や読み取り専用操作ではない。
  await s3.syncDirectoryToS3(runner.getConfigDir(), 'certbot');
  await notifier.sendRenewalSummary(results);
  return response('Certificate renewal process completed', results);
}

async function processCertificate(
  config: CertificateConfig, s3: S3Manager, runner: CertbotRunner, acm: CertificateManager, dryRun: boolean,
): Promise<RenewalResult> {
  const base = { certificateId: config.id, domains: config.domains };
  try {
    if (config.acmCertificateArn && !await acm.needsRenewal(config.acmCertificateArn, config.renewDaysBeforeExpiry)) {
      return { ...base, success: false, skipped: true,
        skipReason: 'Certificate is still valid and not due for renewal', acmCertificateArn: config.acmCertificateArn };
    }
    if (dryRun) return { ...base, success: false, skipped: true,
      skipReason: 'Dry run: issuance and ACM import skipped; S3 sync and notification still run' };
    const paths = await runner.obtainCertificate(config);
    await s3.syncDirectoryToS3(runner.getConfigDir(), 'certbot');
    await s3.saveCertificateBackup(config.id, paths.certPath, paths.privateKeyPath, paths.chainPath, paths.fullChainPath);
    const arn = await acm.importCertificate(paths, config.id, config.acmCertificateArn);
    return { ...base, success: true, acmCertificateArn: arn, expiryDate: await getExpiry(acm, arn) };
  } catch (error) {
    const code = errorCode(error);
    console.error('Certificate renewal failed', { code });
    return { ...base, success: false, error: code };
  }
}

/** メタデータ取得失敗で、保存済みARNを失敗扱いにしない。 */
async function getExpiry(acm: CertificateManager, arn: string): Promise<Date | undefined> {
  try { return (await acm.getCertificateInfo(arn))?.notAfter; }
  catch (error) {
    console.error('Certificate metadata unavailable', { code: errorCode(error) });
    return undefined;
  }
}
