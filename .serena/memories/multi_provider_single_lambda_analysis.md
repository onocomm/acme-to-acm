# Multi-Provider Support Analysis: Single Lambda with Single domains.json

## EXECUTIVE SUMMARY

**YES - The ACME to ACM system CAN manage certificates from multiple ACME providers/accounts with ONE Lambda function and ONE domains.json file.**

The design explicitly supports:
- Multiple ACME providers in one domains.json (JPRS, Let's Encrypt, custom)
- Each certificate configured with its own provider and server URL
- Per-certificate isolation of ACME accounts via Certbot's server-based directory structure
- Automatic certificate renewal from different providers on the same schedule

However, there are important implementation requirements that must be understood.

---

## 1. domains.json SCHEMA SUPPORT FOR MULTIPLE PROVIDERS

### Current CertificateConfig Interface
**File**: `lambda/src/types/domain-config.ts:33-97`

```typescript
export interface CertificateConfig {
  id: string;                          // Unique certificate identifier
  domains: string[];                   // Domains in certificate
  email: string;                       // Contact email
  acmeProvider: AcmeProvider;          // <-- SUPPORTS MULTIPLE: 'jprs' | 'letsencrypt' | 'custom'
  acmeServerUrl?: string;              // Custom ACME server URL (required if provider='custom')
  route53HostedZoneId: string;        // DNS validation zone
  acmCertificateArn: string | null;   // ACM certificate ARN
  renewDaysBeforeExpiry: number;      // Renewal threshold
  enabled: boolean;                    // Enable/disable renewal
  keyType?: KeyType;                   // 'rsa' or 'ecdsa'
  rsaKeySize?: 2048 | 4096;          // RSA key size
}
```

### Key Capabilities
- **Each certificate can have its own acmeProvider**: 'jprs', 'letsencrypt', or 'custom'
- **Per-certificate server URLs**: `acmeServerUrl` allows custom ACME endpoints
- **Per-certificate contact email**: Different emails for different certificates
- **Provider-specific defaults**: Cert-level values override top-level defaults

### Real Example from domains.example.json
```json
{
  "version": "1.0",
  "certificates": [
    {
      "id": "example-com-wildcard",
      "domains": ["example.com", "*.example.com"],
      "email": "admin@example.com",
      "acmeProvider": "jprs",
      "acmeServerUrl": "https://acme.amecert.jprs.jp/DV/getDirectory",
      "route53HostedZoneId": "Z1234567890ABC",
      "enabled": true
    },
    {
      "id": "letsencrypt-example",
      "domains": ["test.example.org"],
      "email": "webmaster@example.org",
      "acmeProvider": "letsencrypt",
      "route53HostedZoneId": "ZLETSENCRYPT456",
      "enabled": true
    },
    {
      "id": "custom-acme-provider",
      "domains": ["custom.example.net"],
      "email": "admin@example.net",
      "acmeProvider": "custom",
      "acmeServerUrl": "https://acme.custom-provider.example/directory",
      "enabled": true
    }
  ]
}
```

This example file shows certificates from JPRS, Let's Encrypt, and custom providers all in ONE domains.json.

---

## 2. CERTBOT ACCOUNT MANAGEMENT & STORAGE

### How Certbot Stores Multiple Accounts

**Critical Finding**: Certbot organizes accounts by **server URL**, not by provider name.

**Certbot directory structure in S3** (`s3://bucket/certbot/`):
```
certbot/
├── config/
│   └── accounts/
│       ├── <hash-of-jprs-url>/        # One account per provider URL
│       │   └── <account-id>/
│       │       └── regr.json          # Registration info
│       ├── <hash-of-letsencrypt-url>/
│       │   └── <account-id>/
│       │       └── regr.json
│       └── <hash-of-custom-url>/
│           └── <account-id>/
│               └── regr.json
├── live/                              # Issued certificates
│   ├── example-com/
│   ├── letsencrypt-example-org/
│   └── custom-example-net/
└── archive/                           # Full certificate history
```

### Key Properties

1. **One ACME account per server URL**: Certbot automatically creates separate accounts for different ACME server URLs
2. **Accounts are identified by account ID**: Each account gets a unique directory within `config/accounts/{server-hash}/{account-id}/`
3. **Multiple accounts CAN coexist**: If you register with JPRS (server X) and Let's Encrypt (server Y), both account directories exist
4. **Server URL determines account scope**: Using `--server URL` flag automatically routes to the correct account

### Implementation Example

```bash
# Register with JPRS (creates: config/accounts/<jprs-hash>/<account-id>/)
certbot register --server https://acme.jprs.jp/directory --eab-kid KID --eab-hmac-key KEY

# Register with Let's Encrypt (creates: config/accounts/<letsencrypt-hash>/<account-id>/)
certbot register --server https://acme-v02.api.letsencrypt.org/directory (no EAB needed)

# Both accounts now coexist in /tmp/certbot/config/accounts/
```

---

## 3. RENEWAL FLOW WITH MULTIPLE PROVIDERS

### Renewal Mode Processing (handleRenewMode)
**File**: `lambda/src/index.ts:340-459`

1. **Download domains.json** from S3
2. **For each certificate entry**:
   - Check if enabled
   - Check if due for renewal (based on ACM cert expiry)
   - Call `processCertificate()` with the config entry
3. **In processCertificate** (`index.ts:476-572`):
   - Extract `acmeProvider` and `acmeServerUrl` from config
   - Call `certbotRunner.obtainCertificate(config)`

### Certbot Command Building
**File**: `lambda/src/certbot/runner.ts:120-167`

```typescript
async obtainCertificate(config: CertificateConfig): Promise<CertbotCertificatePaths> {
  // Get server URL from provider config
  const serverUrl = getServerUrl(config.acmeProvider, config.acmeServerUrl);
  
  // Build Certbot command with --server parameter
  const command = this.buildCertbotCommand({
    domains: config.domains,
    email: config.email,
    serverUrl,  // <-- CRITICAL: This determines which account to use
    route53HostedZoneId: config.route53HostedZoneId,
    // ...
  });
  
  // Execute Certbot with server-specific account
  const output = execSync(command, {
    // ...
  });
}
```

**buildCertbotCommand** adds `--server ${serverUrl}` flag:
```typescript
const args = [
  'certbot certonly',
  '--non-interactive',
  '--agree-tos',
  `--email ${params.email}`,
  '--dns-route53',
  `--server ${params.serverUrl}`,  // <-- Routes to correct account
  `--config-dir ${this.configDir}`,
  // ... other flags
];
```

### Result
- **JPRS certificate**: Uses `--server https://acme.jprs.jp/directory` → uses JPRS account from S3
- **Let's Encrypt certificate**: Uses `--server https://acme-v02.api.letsencrypt.org/directory` → uses Let's Encrypt account from S3
- **Custom certificate**: Uses `--server https://custom.example/directory` → uses custom account from S3
- All in the same Certbot config directory, all processed in one renewal cycle

---

## 4. ACCOUNT REGISTRATION FLOW

### register Mode (handleRegisterMode)
**File**: `lambda/src/index.ts:76-139`

**Workflow**:
1. Receive `RegisterPayload` with:
   - `email`: Account email
   - `server`: ACME server URL
   - `eabKid`, `eabHmacKey`: External Account Binding credentials (if required)

2. Call `certbotRunner.registerAccount(event)`

3. **registerAccount** executes:
```bash
certbot register \
  --non-interactive \
  --agree-tos \
  --email admin@example.com \
  --server https://acme.jprs.jp/directory \
  --eab-kid TEMP_KID \
  --eab-hmac-key TEMP_KEY \
  --config-dir /tmp/certbot/config \
  --work-dir /tmp/certbot/work \
  --logs-dir /tmp/certbot/logs
```

4. Certbot automatically creates account directory:
   - `config/accounts/<server-hash>/<account-id>/regr.json`

5. Sync modified `/tmp/certbot` back to S3 `certbot/` folder

### Multi-Account Registration Pattern

**Register with JPRS**:
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode":"register","email":"admin@example.com","server":"https://acme.jprs.jp/directory","eabKid":"TEMP_KID","eabHmacKey":"TEMP_KEY"}' \
  response.json
```

**Register with Let's Encrypt** (EAB not required):
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode":"register","email":"admin@example.com","server":"https://acme-v02.api.letsencrypt.org/directory"}' \
  response.json
```

**Both accounts now coexist in S3 `certbot/config/accounts/`**

---

## 5. CERTONLY MODE & domains.json CREATION

### How New Certificates Are Added
**File**: `lambda/src/index.ts:164-328`

**Workflow**:
1. Receive `CertonlyPayload` with domains and ACME server URL
2. Download existing Certbot state from S3 `certbot/`
3. Call `certbotRunner.obtainCertificateFromPayload(event)`
4. **New**: Automatically adds certificate entry to domains.json
5. Upload updated Certbot state and domains.json back to S3

**Critical code** (`index.ts:267-298`):
```typescript
// Load or create domains.json
const configJson = await s3Manager.downloadConfig(domainConfigKey);
config = JSON.parse(configJson);

// Create new certificate config
const newCertConfig: CertificateConfig = {
  id: certId,
  domains: event.input.domains,
  email: event.input.email,
  acmeProvider: 'custom',  // <-- Note: certonly always uses 'custom'
  acmeServerUrl: event.input.server,
  route53HostedZoneId: event.input.route53HostedZoneId,
  acmCertificateArn: acmArn,
  renewDaysBeforeExpiry: 30,
  enabled: true,  // <-- Auto-enabled for renewal
  keyType: event.input.keyType || 'rsa',
  rsaKeySize: event.input.rsaKeySize,
};

// Add to domains.json
config.certificates.push(newCertConfig);

// Upload updated config
await s3Manager.uploadFile(domainConfigKey, JSON.stringify(config, null, 2));
```

**Result**: New certificate is automatically added to renewal rotation with its provider/server URL preserved.

---

## 6. PROVIDER CONFIGURATION RESOLUTION

### getProviderConfig Function
**File**: `lambda/src/acme/providers.ts:20-44`

Maps provider names to server URLs and EAB requirements:

```typescript
export function getProviderConfig(provider: AcmeProvider, customServerUrl?: string): AcmeProviderConfig {
  switch (provider) {
    case 'jprs':
      return JPRS_PROVIDER;  // https://acme.jprs.jp/directory
    case 'letsencrypt':
      return LETSENCRYPT_PRODUCTION;  // https://acme-v02.api.letsencrypt.org/directory
    case 'custom':
      if (!customServerUrl) {
        throw new Error('Custom ACME provider requires serverUrl');
      }
      return {
        name: 'custom',
        serverUrl: customServerUrl,
        eabRequired: false,
      };
    default:
      throw new Error(`Unknown ACME provider: ${provider}`);
  }
}
```

### EAB Requirements Check
**File**: `lambda/src/acme/providers.ts:67-70`

```typescript
export function requiresEab(provider: AcmeProvider): boolean {
  const config = getProviderConfig(provider);
  return config.eabRequired;
}
```

**Current EAB Requirements**:
- `'jprs'`: **true** - Requires EAB for account registration
- `'letsencrypt'`: **false** - No EAB required
- `'custom'`: **false** (default) - Configurable per use case

---

## 7. CRITICAL LIMITATION: ONE ACME ACCOUNT PER PROVIDER

### The Constraint

While the system **CAN** manage multiple ACME providers in one domains.json, there is **ONE LIMITATION**:

**Each Lambda instance can only have ONE ACME account registered PER PROVIDER/SERVER URL.**

This means:
- ✅ One JPRS account + One Let's Encrypt account + One custom provider = OK
- ❌ Two different JPRS accounts (different users/EAB credentials) = NOT SUPPORTED
- ❌ Two different Let's Encrypt accounts = NOT SUPPORTED

### Why This Limitation Exists

1. **Certbot account registration is server-URL scoped**: The `config/accounts/{server-hash}/` directory stores all accounts for that server
2. **Certbot register creates ONE account per server**: Running `certbot register` twice to the same server updates/overwrites the account
3. **S3 stores one Certbot config directory**: All certificates share the same `s3://bucket/certbot/` folder
4. **Account re-registration requires new EAB credentials**: Existing account cannot be replaced without new EAB credentials

### Workaround for Multiple Accounts from Same Provider

If you need multiple accounts from the same ACME provider:

**Option 1: Deploy Multiple Lambda Stacks** (Recommended for production)
- Each stack has its own S3 bucket with separate Certbot account state
- Each stack can register with different JPRS/Let's Encrypt accounts
- Separate automatic renewal schedules

**Option 2: Use Different Custom Server URLs** (Workaround)
- Alias the same ACME server to different endpoints
- Certbot will treat them as different servers
- Example: Use both `https://acme.jprs.jp/directory` and `https://acme.jprs.jp:8443/directory`
- **Not recommended** - adds complexity and may violate provider terms

---

## 8. S3 BUCKET STATE MANAGEMENT

### Synchronization Pattern
**Files**: `lambda/src/storage/s3-manager.ts:88-163`

**Before any ACME operation**:
```typescript
// Download Certbot config from S3
await s3Manager.syncS3ToDirectory('certbot', certbotRunner.getConfigDir());
```

**After any ACME operation**:
```typescript
// Upload Certbot config back to S3
await s3Manager.syncDirectoryToS3(certbotRunner.getConfigDir(), 'certbot');
```

This ensures:
- All ACME account state is persisted across Lambda invocations
- Multiple certificates from different providers can reuse existing accounts
- Account information is never lost between invocations

---

## 9. EXAMPLE MULTI-PROVIDER SETUP

### Step 1: Register Accounts (One-time Setup)

**JPRS Account Registration**:
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "mode": "register",
    "email": "admin@example.com",
    "server": "https://acme.jprs.jp/directory",
    "eabKid": "YOUR_JPRS_KID",
    "eabHmacKey": "YOUR_JPRS_HMAC_KEY"
  }' \
  response.json
```

**Let's Encrypt Account Registration** (no EAB):
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "mode": "register",
    "email": "admin@example.com",
    "server": "https://acme-v02.api.letsencrypt.org/directory"
  }' \
  response.json
```

### Step 2: Add Certificates (Creates domains.json Entries)

**Obtain JPRS certificate**:
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "mode": "certonly",
    "domains": ["example.com", "*.example.com"],
    "email": "admin@example.com",
    "server": "https://acme.jprs.jp/directory",
    "route53HostedZoneId": "Z1234567890ABC"
  }' \
  response.json
```

**Obtain Let's Encrypt certificate**:
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "mode": "certonly",
    "domains": ["test.example.org"],
    "email": "admin@example.com",
    "server": "https://acme-v02.api.letsencrypt.org/directory",
    "route53HostedZoneId": "ZLETSENCRYPT456"
  }' \
  response.json
```

### Step 3: Result domains.json

After both certonly calls, domains.json contains:
```json
{
  "version": "1.0",
  "certificates": [
    {
      "id": "manual-example-com",
      "domains": ["example.com", "*.example.com"],
      "email": "admin@example.com",
      "acmeProvider": "custom",
      "acmeServerUrl": "https://acme.jprs.jp/directory",
      "route53HostedZoneId": "Z1234567890ABC",
      "enabled": true,
      "acmCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/jprs-cert"
    },
    {
      "id": "manual-test-example-org",
      "domains": ["test.example.org"],
      "email": "admin@example.com",
      "acmeProvider": "custom",
      "acmeServerUrl": "https://acme-v02.api.letsencrypt.org/directory",
      "route53HostedZoneId": "ZLETSENCRYPT456",
      "enabled": true,
      "acmCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/letsencrypt-cert"
    }
  ]
}
```

### Step 4: Automatic Renewal

After setup, weekly EventBridge trigger (default: Sunday 2AM JST) runs renewal:
```bash
aws lambda invoke --region us-east-1 \
  --function-name AcmeToAcmCertificateRenewer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode": "renew"}' \
  response.json
```

**Renewal process**:
1. Loads domains.json (2 certificates)
2. For JPRS cert: uses `--server https://acme.jprs.jp/directory` → JPRS account
3. For Let's Encrypt cert: uses `--server https://acme-v02.api.letsencrypt.org/directory` → Let's Encrypt account
4. Both certificates renewed in parallel, same Lambda invocation
5. Updated certificates uploaded to ACM

---

## 10. COMPARISON TABLE: SUPPORTED SCENARIOS

| Scenario | Supported | Notes |
|----------|-----------|-------|
| JPRS + Let's Encrypt in one domains.json | **YES** | Different providers, different accounts |
| Same provider, different domains | **YES** | Each certificate is separate entry |
| JPRS + custom ACME server | **YES** | Three accounts total in Certbot state |
| Two JPRS accounts (diff EAB) | **NO** | Would require separate Lambda stacks |
| Two Let's Encrypt accounts | **NO** | Would require separate Lambda stacks |
| Manual edit of domains.json | **YES** | Supported but not recommended for production |
| Per-certificate key types | **YES** | Each cert can use RSA or ECDSA |
| Per-certificate renewal threshold | **YES** | Configurable per certificate |
| Mixed renewal schedules | **PARTIAL** | All certs use same EventBridge schedule, but can be filtered per invocation |

---

## 11. DESIGN STRENGTHS FOR MULTI-PROVIDER

1. **Server URL as Account Key**: Certbot's architecture using server URL as the account identifier means different ACME providers automatically get different account storage
2. **Flexible domains.json Schema**: Each certificate entry can specify its own provider/server URL independently
3. **Per-Invocation Provider Selection**: Every Certbot command includes `--server URL`, routing to correct account
4. **Automatic Account Discovery**: Certbot automatically finds and uses existing accounts for known server URLs
5. **S3-Based State Persistence**: All account state stored centrally, enabling complex multi-provider scenarios

---

## 12. IMPLEMENTATION RECOMMENDATIONS

### For Production Multi-Provider Deployments

1. **Document provider setup in domains.json comments**:
   ```json
   {
     "certificates": [
       {
         "id": "jprs-main",
         "acmeProvider": "jprs",
         "acmeServerUrl": "https://acme.jprs.jp/directory",
         "// NOTE": "Registered with JPRS EAB, renewal requires pre-registered account"
       }
     ]
   }
   ```

2. **Monitor renewal logs per provider**:
   - CloudWatch can filter by certificate ID or provider
   - Each provider may have different renewal patterns

3. **Set up provider-specific alerts**:
   - JPRS renewal failures might need manual EAB credential renewal
   - Let's Encrypt failures might indicate DNS issues

4. **Plan account rotation**:
   - JPRS EAB credentials are temporary
   - Schedule account re-registration before expiry
   - Document account expiry dates in configuration

5. **Test multi-provider renewal regularly**:
   ```bash
   aws lambda invoke --region us-east-1 \
     --function-name AcmeToAcmCertificateRenewer \
     --cli-binary-format raw-in-base64-out \
     --payload '{"mode":"renew","dryRun":true}' \
     response.json
   ```

---

## 13. KEY FINDINGS SUMMARY

| Finding | Status |
|---------|--------|
| Can ONE Lambda manage certs from multiple ACME providers? | ✅ YES |
| Can domains.json contain entries from different providers? | ✅ YES |
| Can each cert have its own server URL? | ✅ YES |
| Can each cert have its own email? | ✅ YES |
| Can Certbot store multiple accounts per provider? | ❌ NO (one per server URL) |
| Can automatic renewal process all providers in one cycle? | ✅ YES |
| Do different providers interfere with each other? | ❌ NO |
| Is account isolation automatic? | ✅ YES (via server URL directories) |
| Can you register multiple accounts from same provider? | ❌ NO (would overwrite) |
| Can you have JPRS + Let's Encrypt + custom provider? | ✅ YES |

---

## CONCLUSION

The ACME to ACM system is **architecturally capable** of managing certificates from multiple ACME providers with a single Lambda function and domains.json file. The design explicitly supports provider configuration at the per-certificate level, and Certbot's account storage mechanism (server URL-based directories) automatically provides account isolation.

The only significant limitation is handling multiple accounts from the same ACME provider, which would require separate Lambda deployments (already supported via the multi-deployment infrastructure using stack suffixes).

For most production scenarios (JPRS for Japan, Let's Encrypt for global + staging), **a single deployment managing multiple providers is the recommended approach**.
