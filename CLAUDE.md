# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ACME to ACM is a serverless certificate renewal system that automatically obtains SSL/TLS certificates from ACME providers (JPRS, Let's Encrypt, etc.) using Certbot on AWS Lambda, validates them via Route53 DNS-01 challenges, and imports them into AWS Certificate Manager (ACM). Designed for CloudFront/S3 deployments where traditional EC2-based Certbot installations aren't viable.

## Build Commands

```bash
# Install dependencies (automatically installs both root and lambda/)
npm install

# Build everything (CDK + Lambda)
npm run build

# Build Lambda function code only
npm run build:lambda

# Watch mode for development
npm run watch                    # CDK
cd lambda && npm run watch       # Lambda

# Deploy everything (builds and deploys)
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
   - All parameters (domains, email, server URL, etc.) passed in event payload
   - Requires pre-registered ACME account (NO EAB in payload)
   - **Automatically creates/updates domains.json** in S3 after successful certificate acquisition
   - Newly obtained certificates are automatically added to renewal rotation

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
  - `handleCertonlyMode()`: Payload-based certificate acquisition, creates/updates domains.json
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

**S3 Bucket Structure**:
```
s3://acme-to-acm-certificates-{account-id}/
├── certbot/                    # Certbot state (synced bidirectionally)
│   ├── config/                 # ACME account registration
│   ├── work/                   # Temporary working files
│   └── logs/                   # Certbot operation logs
├── config/
│   └── domains.json            # Certificate configuration (auto-created by certonly mode)
└── certificates/               # Certificate backups (timestamped)
    └── {domain}/
        └── {timestamp}/
            ├── cert.pem
            ├── chain.pem
            ├── fullchain.pem
            └── privkey.pem
```

### Container Image Architecture: OS-Only Base (provided:al2023)

**Why OS-Only Base Image Instead of Runtime-Specific Images**

This project uses `public.ecr.aws/lambda/provided:al2023` (OS-only Amazon Linux 2023) rather than language-specific base images like `python:3.13` or `nodejs:22`. This architectural decision provides several benefits:

1. **Equal Treatment of Runtimes**: Both Node.js and Python are explicitly installed dependencies, avoiding implicit bias toward one runtime over the other
2. **OpenSSL Compatibility**: Runtime-specific images (especially nodejs) may use `openssl-snapsafe-libs` which is incompatible with Certbot's cryptography package requirements
3. **Explicit Dependency Management**: All dependencies (Node.js 22, Python 3.13, Certbot) are clearly visible in the Dockerfile
4. **Custom Runtime Control**: Full control over runtime versions and Lambda Runtime Interface Client configuration

**Critical Constraint**: **DO NOT** change the base image to `python:3.13`, `nodejs:22`, or any other runtime-specific image, even if deployment or installation errors occur. Troubleshoot within the provided:al2023 context instead.

**Technical Implementation**:
- Base: `public.ecr.aws/lambda/provided:al2023`
- Node.js Runtime: Installed via dnf (Node.js 22)
- Python Runtime: Installed via dnf (Python 3.13)
- Lambda RIC: `aws-lambda-ric` npm package for custom Node.js runtime
- Handler: TypeScript (compiled to `dist/index.handler`)
- ENTRYPOINT: `/usr/bin/npx aws-lambda-ric`
- CMD: `dist/index.handler`
- **NPM Cache**: `ENV NPM_CONFIG_CACHE=/tmp/.npm` (required for npm@8.6.0+ in read-only Lambda filesystem)

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
- **Automatically created/updated** by certonly mode after successful certificate acquisition
- Can be manually edited if needed
- Array of certificate configurations with scheduling and renewal settings

**Dockerfile** (`lambda/Dockerfile`)
- Base: `public.ecr.aws/lambda/provided:al2023` (OS-only Amazon Linux 2023 image)
- Installs both Node.js 22 and Python 3.13 as equal dependencies
- Installs Certbot and certbot-dns-route53 via pip
- Uses AWS Lambda Runtime Interface Client (RIC) for custom Node.js runtime
- Copies compiled TypeScript from `lambda/dist/`
- **NPM Cache Configuration**: Sets `ENV NPM_CONFIG_CACHE=/tmp/.npm` to redirect npm cache writes to Lambda's writable `/tmp` directory (required for npm@8.6.0+, which defaults to read-only `/home/.npm`)
- **CRITICAL**: This base image must NOT be changed to other images (e.g., python:3.13, nodejs:22) even if deployment or installation errors occur. The provided:al2023 approach treats both runtimes equally and avoids OpenSSL compatibility issues

## Development Workflow

### Initial Setup
1. `npm install` (automatically installs both root and lambda/ dependencies)
2. `cdk bootstrap` (if first CDK deployment in region)
3. `npm run deploy` (builds and deploys everything)
4. (Optional) Subscribe to SNS topic manually:
   ```bash
   aws sns subscribe \
     --topic-arn arn:aws:sns:us-east-1:ACCOUNT-ID:AcmeToAcmNotifications \
     --protocol email \
     --notification-endpoint your-email@example.com
   ```
5. Register ACME account (register mode)
6. Obtain certificates (certonly mode) - automatically creates domains.json
7. Automatic renewal will start on weekly schedule

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

### Monitoring and Debugging

**CloudWatch Logs**:
```bash
# Tail logs in real-time
aws logs tail /aws/lambda/AcmeToAcmCertificateRenewer --follow --region us-east-1

# Filter for errors
aws logs tail /aws/lambda/AcmeToAcmCertificateRenewer --filter-pattern "ERROR" --region us-east-1

# View specific time range
aws logs tail /aws/lambda/AcmeToAcmCertificateRenewer \
  --since 1h \
  --region us-east-1
```

**Key Log Patterns**:
- `INIT_REPORT` - Lambda initialization metrics (check for timeouts or errors)
- `START RequestId:` - Function invocation start
- `END RequestId:` - Function invocation end
- `REPORT RequestId:` - Performance metrics (duration, memory, billed duration)
- `ERROR` - Application errors
- `Certbot output:` - Certbot command execution details

**SNS Notifications**:
- Success: Certificate renewal completion with summary
- Error: Failure details with error message and stack trace
- Note: SNS failures don't break the renewal process - CloudWatch Logs are the source of truth

## Troubleshooting

### Docker Build Issues

**Symptom**: `ERROR: failed to commit ... snapshot does not exist: not found`
- **Cause**: Docker buildx cache corruption
- **Solution**: Clean Docker cache and restart
  ```bash
  docker system prune -a -f
  docker buildx prune -a -f
  # Restart Docker Desktop
  ```

**Symptom**: `openssl-snapsafe-libs` conflicts during pip install
- **Cause**: Using wrong base image (e.g., `nodejs:22` instead of `provided:al2023`)
- **Solution**: Ensure Dockerfile uses `public.ecr.aws/lambda/provided:al2023` base image

### Lambda Runtime Errors

**Symptom**: `Runtime.InvalidEntrypoint` or `ProcessSpawnFailed`
- **Cause**: ENTRYPOINT misconfiguration in Dockerfile
- **Solution**: Verify ENTRYPOINT is `/usr/bin/npx aws-lambda-ric` and CMD is `dist/index.handler`

**Symptom**: `EROFS: read-only file system, mkdir '/home/sbx_user1051'`
- **Cause**: npm/npx attempting to write cache to read-only home directory
- **Solution**: Add `ENV NPM_CONFIG_CACHE=/tmp/.npm` to Dockerfile before ENTRYPOINT

**Symptom**: Lambda initialization timeout (9999.99ms)
- **Cause**: Usually related to npm cache issues or missing dependencies
- **Solution**: Check CloudWatch logs for specific error, verify `aws-lambda-ric` is installed

### Deployment Issues

**Symptom**: `docker login ... exited with error code 1: 500 Internal Server Error`
- **Cause**: Docker Desktop not fully started or API incompatibility
- **Solution**:
  1. Verify Docker is running: `docker info`
  2. Restart Docker Desktop completely
  3. Wait 30-60 seconds for full initialization

**Symptom**: Deployment succeeds but Lambda returns 500 with "key does not exist"
- **Cause**: Normal behavior - `config/domains.json` doesn't exist yet
- **Solution**: Run certonly mode to create initial certificate configuration

### Lambda Invocation

**Always specify region** for Lambda invocations:
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"input":{"mode":"renew","dryRun":true}}' \
  response.json
```

## Common Payload Examples

All Lambda invocations must specify `--region us-east-1` and `--cli-binary-format raw-in-base64-out`:

```bash
# Register ACME account (JPRS)
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"input":{"mode":"register","email":"admin@example.com","server":"https://acme.amecert.jprs.jp/DV/getDirector","eabKid":"TEMP_KID","eabHmacKey":"TEMP_KEY"}}' \
  response.json

# Obtain certificate manually
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"input":{"mode":"certonly","domains":["example.com","*.example.com"],"email":"admin@example.com","server":"https://acme.amecert.jprs.jp/DV/getDirector","route53HostedZoneId":"Z123","keyType":"rsa","rsaKeySize":2048}}' \
  response.json

# Manual renewal (all enabled certificates)
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"input":{"mode":"renew"}}' \
  response.json

# Dry run renewal
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"input":{"mode":"renew","dryRun":true}}' \
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

JPRS requires three-step workflow:
1. Obtain temporary EAB credentials from JPRS portal
2. Use **register mode** with EAB to create ACME account (one-time)
3. Use **certonly mode** to obtain certificates (no EAB required)
   - Automatically creates/updates domains.json for renewal tracking
4. **renew mode** runs automatically weekly for all registered certificates

EAB credentials are invalidated by JPRS after successful registration - do not attempt to reuse.

**Important**: After certonly mode successfully obtains a certificate, it is automatically added to domains.json in S3. Manual editing of domains.json is optional - certonly mode handles the configuration lifecycle.
