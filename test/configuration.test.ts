import { findCertificate, parseConfiguration } from '../lambda/src/configuration';

const input = (domain: string) => ({ mode: 'certonly' as const, domains: [domain],
  email: 'admin@example.com', server: 'https://acme.example.com/directory', route53HostedZoneId: 'Z123' });
const certificate = (id: string, domain: string) => ({ id, domains: [domain], email: 'admin@example.com',
  acmeProvider: 'custom' as const, acmeServerUrl: 'https://acme.example.com/directory',
  route53HostedZoneId: 'Z123', acmCertificateArn: 'arn:existing', renewDaysBeforeExpiry: 30, enabled: true });

test('旧IDが衝突する異なるドメインにも安定した別IDを割り当てる', () => {
  const config = { version: '1.0', certificates: [certificate('manual-a-b-example-com', 'a.b.example.com')] };
  const first = findCertificate(config, input('a-b.example.com'));
  const second = findCertificate(config, input('a-b.example.com'));
  expect(first.id).toEqual(second.id);
  expect(first.id).not.toBe('manual-a-b-example-com');
  config.certificates.push(certificate(first.id, 'a-b.example.com'));
  expect(findCertificate(config, input('a-b.example.com')).existing?.acmCertificateArn).toBe('arn:existing');
});

test('大文字小文字が違っても既存IDとARNを再利用する', () => {
  const existing = certificate('stable-id', 'Example.COM');
  expect(findCertificate({ version: '1.0', certificates: [existing] }, input('example.com')))
    .toEqual({ id: 'stable-id', existing });
});

test.each([
  [certificate('same', 'a.example.com'), certificate('same', 'b.example.com')],
  [certificate('one', 'a.example.com'), certificate('two', 'A.example.com')],
  [certificate('one', 'a.example.com'), certificate('two', 'b.example.com')],
])('重複する既存設定を勝手に統合せず停止する', certificates => {
  expect(() => parseConfiguration(JSON.stringify({ version: '1.0', certificates })))
    .toThrow('InvalidConfiguration');
});

test.each([undefined, 'arn:existing'])('SANの順序が変わっても既存IDとARNを再利用する: %s', acmCertificateArn => {
  const existing = { ...certificate('stable-id', 'example.com'), domains: ['example.com', 'www.example.com'] };
  const result = findCertificate({ version: '1.0', certificates: [existing] }, {
    ...input('www.example.com'), domains: ['WWW.example.com', 'example.com'], acmCertificateArn,
  });
  expect(result).toEqual({ id: 'stable-id', existing });
});

test('明示ARNで対象を特定したドメイン変更も既存IDを保持する', () => {
  const existing = certificate('stable-id', 'example.com');
  expect(findCertificate({ version: '1.0', certificates: [existing] }, {
    ...input('new.example.com'), acmCertificateArn: 'arn:existing',
  })).toEqual({ id: 'stable-id', existing });
});

test('ドメインと明示ARNが別の設定を指す場合は停止する', () => {
  const certificates = [certificate('one', 'a.example.com'),
    { ...certificate('two', 'b.example.com'), acmCertificateArn: 'arn:other' }];
  expect(() => findCertificate({ version: '1.0', certificates }, {
    ...input('a.example.com'), acmCertificateArn: 'arn:other',
  })).toThrow('InvalidInput');
});
