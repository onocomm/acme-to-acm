import { createHash } from 'crypto';
import { DomainConfiguration, CertificateConfig, CertonlyPayload } from './types/domain-config';
import { failure } from './diagnostics';

export function parseConfiguration(content: string): DomainConfiguration {
  let config: DomainConfiguration;
  try { config = JSON.parse(content); } catch { throw failure('InvalidConfiguration'); }
  if (!config || typeof config.version !== 'string' || !Array.isArray(config.certificates)) {
    throw failure('InvalidConfiguration');
  }
  const ids = new Set<string>();
  const primaryDomains = new Set<string>();
  const arns = new Set<string>();
  for (const cert of config.certificates) {
    if (!cert || typeof cert.id !== 'string' || !cert.id || ids.has(cert.id) ||
      !validDomains(cert.domains) || typeof cert.email !== 'string' || !cert.email ||
      !['jprs', 'letsencrypt', 'custom'].includes(cert.acmeProvider) ||
      (cert.acmeProvider === 'custom' && !validServer(cert.acmeServerUrl)) ||
      typeof cert.route53HostedZoneId !== 'string' || !cert.route53HostedZoneId ||
      !(cert.acmCertificateArn === null || typeof cert.acmCertificateArn === 'string') ||
      typeof cert.enabled !== 'boolean' || !Number.isFinite(cert.renewDaysBeforeExpiry) ||
      cert.renewDaysBeforeExpiry < 0 || primaryDomains.has(cert.domains[0].toLowerCase()) ||
      (cert.acmCertificateArn !== null && (!cert.acmCertificateArn || arns.has(cert.acmCertificateArn)))) {
      throw failure('InvalidConfiguration');
    }
    ids.add(cert.id);
    primaryDomains.add(cert.domains[0].toLowerCase());
    if (cert.acmCertificateArn) arns.add(cert.acmCertificateArn);
  }
  return config;
}

export function validServer(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function validDomains(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(domain =>
    typeof domain === 'string' && domain.length <= 253 &&
    /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain));
}

/** 既存IDを優先する。旧manual-IDが衝突する別ドメインには安定ハッシュを付ける。 */
export function findCertificate(config: DomainConfiguration, input: CertonlyPayload['input']): {
  id: string; existing?: CertificateConfig;
} {
  const primary = input.domains[0].toLowerCase();
  const domainSet = (domains: string[]) => [...new Set(domains.map(d => d.toLowerCase()))].sort().join(',');
  const requestedDomains = domainSet(input.domains);
  const candidates = config.certificates.filter(c =>
    c.domains[0].toLowerCase() === primary || domainSet(c.domains) === requestedDomains ||
    (!!input.acmCertificateArn && c.acmCertificateArn === input.acmCertificateArn));
  // ドメインと明示ARNが別々の設定を指す場合は、片方を勝手に上書きしない。
  if (candidates.length > 1) throw failure('InvalidInput');
  const existing = candidates[0];
  if (existing) {
    if (existing.acmCertificateArn && input.acmCertificateArn &&
      existing.acmCertificateArn !== input.acmCertificateArn) throw failure('InvalidInput');
    return { id: existing.id, existing };
  }
  const legacyId = `manual-${primary.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const id = config.certificates.some(c => c.id === legacyId)
    ? `${legacyId}-${createHash('sha256').update(primary).digest('hex').slice(0, 12)}` : legacyId;
  if (config.certificates.some(c => c.id === id)) throw failure('InvalidConfiguration');
  return { id };
}
