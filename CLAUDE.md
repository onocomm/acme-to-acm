# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ACME to ACM is a serverless certificate renewal system that automatically obtains SSL/TLS certificates from ACME providers (JPRS, Let's Encrypt, etc.) using Certbot on AWS Lambda, validates them via Route53 DNS-01 challenges, and imports them into AWS Certificate Manager (ACM). Designed for CloudFront/S3 deployments where traditional EC2-based Certbot installations aren't viable.

## Build Commands

```bash
# Build CDK infrastructure (TypeScript → JavaScript)
npm run build

# Build Lambda function code
npm run build:lambda

# Watch mode for development
npm run watch                    # CDK
cd lambda && npm run watch       # Lambda

# Deploy everything (builds both CDK and Lambda, then deploys)
npm run deploy

# View CloudFormation template
npm run synth

# View infrastructure changes before deployment
npm run diff

# Run tests
npm test
```

## Architecture

### Three-Mode Operation Model

The system operates in three distinct modes based on Lambda event payload:

1. **register mode**: One-time ACME account registration with External Account Binding (EAB) credentials
   - Required for JPRS and other EAB-enabled providers
   - EAB credentials are temporary and invalidated after registration
   - Account info persisted to S3 for subsequent operations

2. **certonly mode**: Manual certificate acquisition from payload parameters
   - No domains.json required
   - All parameters (domains, email, server URL, etc.) passed in event payload
   - Requires pre-registered ACME account (NO EAB in payload)
   - Useful for ad-hoc certificate requests

3. **renew mode**: Automated renewal based on domains.json configuration
   - Weekly EventBridge trigger (default: Sunday 2AM JST)
   - Reads certificate list from S3 `config/domains.json`
   - Only renews certificates approaching expiration (configurable threshold)
   - Primary operational mode after initial setup

### Component Architecture

**CDK Infrastructure** (`lib/`)
- `acme-to-acm-stack.ts`: Main orchestration stack
- `constructs/storage.ts`: S3 bucket for Certbot state and certificate backups
- `constructs/notification.ts`: SNS topic for success/failure alerts
- `constructs/certificate-lambda.ts`: Lambda function (Docker image), IAM policies, EventBridge schedule

**Lambda Function** (`lambda/src/`)
- `index.ts`: Mode router (register/certonly/renew)
  - `handleRegisterMode()`: EAB account registration
  - `handleCertonlyMode()`: Payload-based certificate acquisition
  - `handleRenewMode()`: Config-based renewal workflow
- `certbot/runner.ts`: Certbot command wrapper
  - `registerAccount()`: Executes `certbot register` with EAB
  - `obtainCertificateFromPayload()`: Executes `certbot certonly` from payload
  - `obtainCertificate()`: Executes `certbot certonly` from config
  - `buildCertbotCommand()`: Constructs Certbot CLI with key type options
- `acm/certificate-manager.ts`: ACM import/re-import operations
- `storage/s3-manager.ts`: S3 operations (config download, Certbot state sync, certificate backup)
- `notification/notifier.ts`: SNS notifications

### Certbot State Management

Critical design pattern: Certbot account registration state is ephemeral within Lambda but persisted across invocations:

1. Lambda cold start: Download Certbot config directory from S3 to `/tmp/certbot`
2. Execute Certbot operations (uses local account info)
3. Upload Certbot config directory back to S3 after operations
4. Lambda cleanup: `/tmp/certbot` discarded

This enables stateless Lambda functions to maintain ACME account continuity.

### Key Type Support

Certificates can use different key algorithms (configurable in domains.json or certonly payload):
- `keyType: "rsa"` with `rsaKeySize: 2048` (default) or `4096`
- `keyType: "ecdsa"` (no size parameter, uses Certbot defaults)

Certbot command includes `--key-type` and conditionally `--rsa-key-size` flags.

## Critical Files

**Type Definitions** (`lambda/src/types/domain-config.ts`)
- `RegisterPayload`: EAB credentials (eabKid, eabHmacKey), email, server
- `CertonlyPayload`: domains[], email, server, route53HostedZoneId, optional acmCertificateArn
- `RenewPayload`: optional certificateIds[], dryRun flag
- `CertificateConfig`: Schema for domains.json entries

**Configuration** (`config/domains.json`)
- Not checked into git (use `domains.example.json` as template)
- Uploaded to S3 post-deployment
- Array of certificate configurations with scheduling and renewal settings

**Dockerfile** (`lambda/Dockerfile`)
- Base: `public.ecr.aws/lambda/nodejs:22`
- Installs Python 3 + pip, then Certbot and certbot-dns-route53 from PyPI
- Copies compiled TypeScript from `lambda/dist/`

## Development Workflow

### Initial Setup
1. `npm install` (root) and `cd lambda && npm install`
2. Copy `config/domains.example.json` to `config/domains.json` and configure
3. `cdk bootstrap` (if first CDK deployment in region)
4. `npm run deploy`
5. Upload `config/domains.json` to S3 (bucket name in CDK outputs)
6. Confirm SNS subscription email if notification address configured

### Making Changes

**CDK Infrastructure Changes:**
- Modify files in `lib/` or `bin/`
- `npm run diff` to preview changes
- `npm run deploy` to apply

**Lambda Code Changes:**
- Modify TypeScript in `lambda/src/`
- `cd lambda && npm run build` (or use watch mode)
- `npm run deploy` from root (rebuilds Docker image)
- Note: Docker image rebuild takes 5-10 minutes

**Testing Lambda Locally:**
Lambda uses Docker container image - local testing requires Docker runtime simulation. Recommended approach:
1. Deploy to AWS
2. Test with `aws lambda invoke` (see README examples)
3. Monitor CloudWatch Logs: `aws logs tail /aws/lambda/AcmeToAcmCertificateRenewer --follow`

## Common Payload Examples

```bash
# Register ACME account (JPRS)
aws lambda invoke --function-name AcmeToAcmCertificateRenewer \
  --payload '{"mode":"register","email":"admin@example.com","server":"https://acme.jprs.jp/directory","eabKid":"TEMP_KID","eabHmacKey":"TEMP_KEY"}' \
  response.json

# Obtain certificate manually
aws lambda invoke --function-name AcmeToAcmCertificateRenewer \
  --payload '{"mode":"certonly","domains":["example.com","*.example.com"],"email":"admin@example.com","server":"https://acme.jprs.jp/directory","route53HostedZoneId":"Z123","keyType":"rsa","rsaKeySize":2048}' \
  response.json

# Manual renewal (all enabled certificates)
aws lambda invoke --function-name AcmeToAcmCertificateRenewer \
  --payload '{"mode":"renew"}' \
  response.json

# Dry run renewal
aws lambda invoke --function-name AcmeToAcmCertificateRenewer \
  --payload '{"mode":"renew","dryRun":true}' \
  response.json
```

## Important Constraints

- **Region Lock**: Must deploy to `us-east-1` for CloudFront certificate compatibility (ACM requirement)
- **Lambda Timeout**: 15 minutes max (configured in `certificate-lambda.ts`)
- **Ephemeral Storage**: 2GB (`/tmp` for Certbot operations)
- **No Secrets Manager**: EAB credentials passed via payload (temporary by design), not stored
- **ACME Account Scope**: One ACME account per S3 bucket (shared across all certificates)

## Route53 Permissions

Lambda requires these Route53 permissions for DNS-01 validation:
- `route53:ListHostedZones` (global)
- `route53:GetChange` (global)
- `route53:ChangeResourceRecordSets` (per hosted zone)
- `route53:GetHostedZone` (per hosted zone)
- `route53:ListResourceRecordSets` (per hosted zone)

Certbot's Route53 plugin uses AWS SDK credentials from Lambda execution role automatically.

## EventBridge Schedule

Weekly trigger configured in `lib/constructs/certificate-lambda.ts`:
- Default: `cron(0 17 ? * SUN *)` (Sunday 17:00 UTC = Sunday 02:00 JST)
- Payload: `{mode: "renew"}`
- Customize via `scheduleExpression` prop in `bin/acme-to-acm.ts`
- Disable via `enableSchedule: false`

## JPRS-Specific Notes

JPRS requires two-step workflow:
1. Obtain temporary EAB credentials from JPRS portal
2. Use **register mode** with EAB to create ACME account (one-time)
3. Use **certonly mode** or **renew mode** for all subsequent operations (no EAB required)

EAB credentials are invalidated by JPRS after successful registration - do not attempt to reuse.
