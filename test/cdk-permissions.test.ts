import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AcmeToAcmStack, AcmeToAcmStackProps } from '../lib/acme-to-acm-stack';

function synth(props: AcmeToAcmStackProps = {}): Template {
  const app = new cdk.App();
  return Template.fromStack(new AcmeToAcmStack(app, 'PermissionsTest', props));
}

function route53Statements(template: Template): any[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
    .filter((statement: any) => [statement.Action].flat().some((action: string) => action.startsWith('route53:')));
}

describe('certificate state concurrency and DNS permissions', () => {
  test('serializes invocations and keeps the existing Monday JST schedule', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 1 });
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 17 ? * SUN *)' });
  });

  test('keeps all-zone compatibility only when the restriction is omitted', () => {
    const statements = route53Statements(synth());
    expect(statements).toContainEqual(expect.objectContaining({
      Action: ['route53:ChangeResourceRecordSets', 'route53:GetHostedZone', 'route53:ListResourceRecordSets'],
      Resource: 'arn:aws:route53:::hostedzone/*',
    }));
  });

  test('restricts each zone to its own exact challenge TXT names and operations', () => {
    const statements = route53Statements(synth({
      route53ChallengeZones: [
        { hostedZoneId: 'Z111111', recordNames: ['_acme-challenge.Example.com.', '_acme-challenge.www.example.com'] },
        { hostedZoneId: 'Z222222', recordNames: ['_acme-challenge.example.net'] },
      ],
    }));
    const changes = statements.filter((statement) => [statement.Action].flat().includes('route53:ChangeResourceRecordSets'));
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual(expect.objectContaining({
      Action: 'route53:ChangeResourceRecordSets',
      Condition: { 'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['_acme-challenge.example.com', '_acme-challenge.www.example.com'],
        'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
        'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
      } },
    }));
    expect(JSON.stringify(changes[0].Resource)).toContain('hostedzone/Z111111');
    expect(JSON.stringify(changes[1].Resource)).toContain('hostedzone/Z222222');
    expect(changes[1].Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsNormalizedRecordNames'])
      .toEqual(['_acme-challenge.example.net']);
    expect(JSON.stringify(statements)).not.toContain('hostedzone/*');
    expect(statements).toContainEqual(expect.objectContaining({
      Action: ['route53:ListHostedZones', 'route53:GetChange'],
      Resource: '*',
    }));
  });

  test.each([
    [],
    [{ hostedZoneId: '*', recordNames: ['_acme-challenge.example.com'] }],
    [{ hostedZoneId: 'Z111111', recordNames: [] }],
    [{ hostedZoneId: 'Z111111', recordNames: ['*.example.com'] }],
    [{ hostedZoneId: 'Z111111', recordNames: ['_acme-challenge.*.example.com'] }],
    [{ hostedZoneId: 'Z111111', recordNames: ['www.example.com'] }],
    [{ hostedZoneId: 'Z111111', recordNames: ['_acme-challenge..example.com'] }],
    [{ hostedZoneId: 'Z111111', recordNames: ['_acme-challenge.-example.com'] }],
  ].map((zones) => [zones]))('rejects invalid restrictions rather than falling back to broad access: %j', (route53ChallengeZones) => {
    expect(() => synth({ route53ChallengeZones } as AcmeToAcmStackProps)).toThrow(/route53ChallengeZones/);
  });
});
