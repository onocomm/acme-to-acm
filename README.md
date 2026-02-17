# acme-to-acm

ACME プロトコルを使用したサーバー証明書の自動更新システム。Lambda 上の Certbot で証明書を取得し、Route53 で DNS 認証を行い、AWS Certificate Manager (ACM) にインポートします。

## 概要

このプロジェクトは、JPRS や Let's Encrypt などの ACME プロバイダーから証明書を自動取得し、AWS ACM にインポートするシステムです。CloudFront などのサービスで使用する証明書の自動更新に最適です。

### 主な機能

- ✅ JPRS、Let's Encrypt、カスタム ACME プロバイダーに対応
- ✅ 複数ドメインの一括管理
- ✅ Route53 による DNS-01 チャレンジの自動実行
- ✅ ACM への証明書の新規作成または既存証明書への再インポート
- ✅ S3 への証明書バックアップ
- ✅ 週次での自動更新チェック（カスタマイズ可能）
- ✅ SNS によるメール通知
- ✅ すべてのリソースを AWS CDK でデプロイ

## アーキテクチャ

```
┌─────────────────────┐
│  EventBridge Rule   │ (Weekly Schedule)
│  (日曜 午前2時JST)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Lambda Function    │
│  (Container Image)  │
│  - AL2023 OS-only   │
│  - Node.js 22       │
│  - Python 3.13      │
│  - Certbot          │
└──────────┬──────────┘
           │
     ┌─────┴─────┬─────────┬─────────┐
     ▼           ▼         ▼         ▼
┌─────────┐ ┌────────┐ ┌────────┐ ┌──────┐
│   S3    │ │Route53 │ │  ACM   │ │ SNS  │
│ Bucket  │ │ DNS    │ │ Import │ │Notify│
└─────────┘ └────────┘ └────────┘ └──────┘
```

### コンテナイメージの構成

このプロジェクトは `public.ecr.aws/lambda/provided:al2023` (Amazon Linux 2023 OS-only ベースイメージ) を使用しています。これにより、Node.js と Python の両方を対等な依存関係として扱い、以下の利点があります：

- **ランタイムの対等な扱い**: Node.js 22 と Python 3.13 の両方を明示的にインストール
- **OpenSSL 互換性**: ランタイム固有のイメージで発生する OpenSSL 互換性の問題を回避
- **依存関係の明確化**: すべての依存関係が Dockerfile に明記される
- **カスタムランタイム制御**: AWS Lambda Runtime Interface Client (RIC) による完全な制御

**重要**: デプロイやインストールでエラーが発生しても、`python:3.13` や `nodejs:22` などのランタイム固有のイメージに変更しないでください。`provided:al2023` の範囲内でトラブルシューティングを行います。

## ディレクトリ構造

```
acme-to-acm/
├── bin/
│   └── acme-to-acm.ts              # CDK エントリポイント
├── lib/
│   ├── acme-to-acm-stack.ts        # メイン CDK スタック
│   └── constructs/
│       ├── storage.ts               # S3 バケット構成
│       ├── notification.ts          # SNS 通知構成
│       └── certificate-lambda.ts    # Lambda 関数構成
├── lambda/
│   ├── src/
│   │   ├── index.ts                 # Lambda ハンドラー
│   │   ├── acme/                    # ACME プロバイダー設定
│   │   ├── acm/                     # ACM 操作
│   │   ├── certbot/                 # Certbot 実行ラッパー
│   │   ├── storage/                 # S3 操作
│   │   ├── notification/            # SNS 通知
│   │   └── types/                   # TypeScript 型定義
│   ├── Dockerfile                   # Lambda コンテナイメージ
│   ├── package.json
│   └── tsconfig.json
├── config/
│   └── domains.example.json         # ドメイン設定サンプル
├── cdk.json
├── package.json
└── README.md
```

## 前提条件

- Node.js 22 以上
- AWS CLI 設定済み
- **Docker Desktop** (Lambda コンテナイメージビルド用)
  - [macOS](https://docs.docker.com/desktop/install/mac-install/)
  - [Windows](https://docs.docker.com/desktop/install/windows-install/)
  - [Linux](https://docs.docker.com/desktop/install/linux-install/)
  - インストール後、Docker Desktop を起動してください
  - 動作確認: `docker ps` が正常に実行できること
- AWS CDK CLI (`npm install -g aws-cdk`)

## セットアップ

### 1. 依存関係のインストール

```bash
# ルートでインストール（lambda/ ディレクトリも自動的にインストールされます）
npm install
```

### 2. CDK ブートストラップ（初回のみ）

```bash
cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

### 3. デプロイ

```bash
# ビルドとデプロイを一括実行（CDK と Lambda の両方がビルドされます）
npm run deploy
```

デプロイには 5〜10 分程度かかります（Docker イメージのビルドとアップロードのため）。

### 4. SNS サブスクリプションの設定（オプション）

メール通知を受け取りたい場合は、SNS トピックに手動でサブスクライブします：

```bash
# トピック ARN はデプロイ時の出力から確認
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT-ID:AcmeToAcmNotifications \
  --protocol email \
  --notification-endpoint your-email@example.com

# 確認メールが届くのでリンクをクリック
```

## マルチアカウントデプロイ

このプロジェクトは複数の AWS アカウントへのデプロイに対応しています。AWS CLI のプロファイル機能を使用して、アカウントを切り替えることができます。

### 前提条件

`~/.aws/credentials` に複数のプロファイルが設定されていること：

```ini
[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...

[production]
aws_access_key_id = AKIA...
aws_secret_access_key = ...

[staging]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

### 方法1: 環境変数を使う（推奨）

環境変数 `AWS_PROFILE` を指定してコマンドを実行：

```bash
# Bootstrap（初回のみ）
# ACCOUNT-ID は対象アカウントの AWS アカウント ID（12桁の数字）に置き換えてください
AWS_PROFILE=production cdk bootstrap aws://ACCOUNT-ID/us-east-1

# デプロイ
AWS_PROFILE=production npm run deploy

# 差分確認
AWS_PROFILE=staging npm run diff

# スタック削除
AWS_PROFILE=staging cdk destroy
```

### 方法2: --profile オプションを使う

CDK コマンドに直接 `--profile` オプションを指定：

```bash
# Bootstrap（初回のみ）
# ACCOUNT-ID は対象アカウントの AWS アカウント ID（12桁の数字）に置き換えてください
cdk bootstrap aws://ACCOUNT-ID/us-east-1 --profile production

# デプロイ（ビルドしてから）
npm run build
cdk deploy --profile production

# 差分確認
npm run build
cdk diff --profile staging
```

### マルチスタック + マルチアカウント

異なるアカウントに異なるスタックをデプロイすることも可能：

```bash
# アカウントA に JPRS 用スタックをデプロイ
AWS_PROFILE=account-a STACK_SUFFIX=-jprs npm run deploy

# アカウントB に Let's Encrypt 用スタックをデプロイ
AWS_PROFILE=account-b STACK_SUFFIX=-letsencrypt npm run deploy
```

### 注意事項

- **リージョン固定**: CloudFront 証明書の要件により、常に `us-east-1` にデプロイされます
- **Bootstrap**: 各アカウント・リージョンで初回のみ `cdk bootstrap` が必要です
- **Bootstrap のアカウント ID**: `aws://ACCOUNT-ID/us-east-1` の ACCOUNT-ID は、デプロイ先のアカウント ID（12桁の数字）に置き換えてください
  - アカウント ID の確認方法: `AWS_PROFILE=プロファイル名 aws sts get-caller-identity --query Account --output text`
- **Lambda 実行**: デプロイ後の Lambda 実行時も同じプロファイルを指定してください

```bash
# 証明書取得（production アカウント）
AWS_PROFILE=production aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"input":{"mode":"certonly",...}}' \
  response.json
```

## マルチリージョンデプロイ

### デフォルトリージョン（CloudFront 用）

デフォルトでは `us-east-1` にデプロイされます。CloudFront ディストリビューションで使用する証明書は必ず us-east-1 にインポートする必要があります。

```bash
# デフォルト（us-east-1）
npm run deploy
```

### 別リージョンへのデプロイ（ALB/ELB 用）

ALB、NLB、API Gateway などで使用する証明書は、リソースと同じリージョンに配置する必要があります。環境変数 `CDK_DEPLOY_REGION` でリージョンを指定できます。

```bash
# ap-northeast-1（東京）にデプロイ
CDK_DEPLOY_REGION=ap-northeast-1 npm run deploy

# eu-west-1（アイルランド）にデプロイ
CDK_DEPLOY_REGION=eu-west-1 npm run deploy

# Bootstrap も同じリージョンで実行（初回のみ）
CDK_DEPLOY_REGION=ap-northeast-1 cdk bootstrap aws://ACCOUNT-ID/ap-northeast-1
```

### マルチリージョン + マルチアカウント + マルチスタック

すべてを組み合わせることも可能：

```bash
# アカウント A の us-east-1 に CloudFront 用スタックをデプロイ
AWS_PROFILE=account-a STACK_SUFFIX=-cloudfront npm run deploy

# アカウント A の ap-northeast-1 に ALB 用スタックをデプロイ
AWS_PROFILE=account-a CDK_DEPLOY_REGION=ap-northeast-1 STACK_SUFFIX=-alb-tokyo npm run deploy

# アカウント B の eu-west-1 に ALB 用スタックをデプロイ
AWS_PROFILE=account-b CDK_DEPLOY_REGION=eu-west-1 STACK_SUFFIX=-alb-ireland npm run deploy
```

### 注意事項

- **CloudFront 証明書**: 必ず `us-east-1` にデプロイしてください（AWS の仕様）
- **ALB/NLB 証明書**: ALB/NLB と同じリージョンにデプロイしてください
- **Lambda 実行**: リージョンを指定してください
  ```bash
  aws lambda invoke \
    --function-name AcmeToAcmCertificateRenewer \
    --region ap-northeast-1 \
    --cli-binary-format raw-in-base64-out \
    --payload '{"input":{"mode":"certonly",...}}' \
    response.json
  ```
- **CloudWatch Logs**: リージョンごとに別のロググループが作成されます
  ```bash
  aws logs tail /aws/lambda/AcmeToAcmCertificateRenewer \
    --follow \
    --region ap-northeast-1
  ```

## 使い方

このシステムは3つのモードで動作します：

- **register**: ACME アカウントの登録（EAB 認証）
- **certonly**: 証明書の手動取得とACMインポート
- **renew**: domains.json に基づく自動更新（週次スケジュール）

### Mode 1: register（アカウント登録）

JPRS などの EAB が必要なプロバイダーで最初にアカウントを登録します。

#### パラメーター

| パラメーター | 必須 | 型 | 説明 | 例 |
|------------|------|-----|------|-----|
| `mode` | ✅ 必須 | string | 実行モード（固定値） | `"register"` |
| `email` | ✅ 必須 | string | 連絡先メールアドレス | `"admin@example.com"` |
| `server` | ✅ 必須 | string | ACME サーバー URL | `"https://acme.amecert.jprs.jp/DV/getDirectory"` |
| `eabKid` | ✅ 必須 | string | External Account Binding Key ID（JPRS から一時発行） | `"YOUR_TEMPORARY_EAB_KID"` |
| `eabHmacKey` | ✅ 必須 | string | External Account Binding HMAC Key（JPRS から一時発行） | `"YOUR_TEMPORARY_EAB_HMAC_KEY"` |

```bash
# JPRS から一時的に発行された EAB 認証情報を使用
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "input": {
      "mode": "register",
      "email": "admin@example.com",
      "server": "https://acme.amecert.jprs.jp/DV/getDirectory",
      "eabKid": "YOUR_TEMPORARY_EAB_KID",
      "eabHmacKey": "YOUR_TEMPORARY_EAB_HMAC_KEY"
    }
  }' \
  --region us-east-1 \
  response.json

# 実行結果を確認
cat response.json
```

**注意**: EAB 認証情報は一時的なもので、登録後は無効化されます。

### Mode 2: certonly（証明書の手動取得）

ペイロードで指定したドメインの証明書を取得し、ACM にインポートします。

#### パラメーター

| パラメーター | 必須 | 型 | デフォルト | 説明 | 例 |
|------------|------|-----|-----------|------|-----|
| `mode` | ✅ 必須 | string | - | 実行モード（固定値） | `"certonly"` |
| `domains` | ✅ 必須 | string[] | - | 証明書に含めるドメインのリスト | `["example.com", "*.example.com"]` |
| `email` | ✅ 必須 | string | - | 連絡先メールアドレス | `"admin@example.com"` |
| `server` | ✅ 必須 | string | - | ACME サーバー URL | `"https://acme.amecert.jprs.jp/DV/getDirectory"` |
| `route53HostedZoneId` | ✅ 必須 | string | - | DNS 検証用の Route53 ホストゾーン ID | `"Z1234567890ABC"` |
| `acmCertificateArn` | ⭕ オプション | string | `null` | 既存 ACM 証明書への再インポート時に指定 | `"arn:aws:acm:us-east-1:123456789012:certificate/xxx"` |
| `keyType` | ⭕ オプション | `"rsa"` \| `"ecdsa"` | `"rsa"` | 証明書のキータイプ | `"rsa"` または `"ecdsa"` |
| `rsaKeySize` | ⭕ オプション | `2048` \| `4096` | `2048` | RSA キーサイズ（`keyType` が `"rsa"` の場合のみ有効） | `2048` または `4096` |
| `forceRenewal` | ⭕ オプション | boolean | `false` | 有効期限前でも強制的に更新するか | `true` または `false` |

```bash
# 新規証明書の取得
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "input": {
      "mode": "certonly",
      "domains": ["example.com", "*.example.com"],
      "email": "admin@example.com",
      "server": "https://acme.amecert.jprs.jp/DV/getDirectory",
      "route53HostedZoneId": "Z1234567890ABC",
      "keyType": "rsa",
      "rsaKeySize": 2048
    }
  }' \
  --region us-east-1 \
  response.json

# 既存 ACM 証明書への再インポート
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "input": {
      "mode": "certonly",
      "domains": ["example.com", "*.example.com"],
      "email": "admin@example.com",
      "server": "https://acme.amecert.jprs.jp/DV/getDirectory",
      "route53HostedZoneId": "Z1234567890ABC",
      "acmCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/existing-cert-id",
      "keyType": "rsa",
      "rsaKeySize": 2048,
      "forceRenewal": true
    }
  }' \
  --region us-east-1 \
  response.json

# ECDSA 鍵を使用した証明書の取得
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "input": {
      "mode": "certonly",
      "domains": ["test.example.org"],
      "email": "webmaster@example.org",
      "server": "https://acme-v02.api.letsencrypt.org/directory",
      "route53HostedZoneId": "ZLETENCRYPT456",
      "keyType": "ecdsa"
    }
  }' \
  --region us-east-1 \
  response.json
```

### Mode 3: renew（自動更新）

domains.json の設定に基づいて証明書を更新します（週次スケジュールで自動実行）。

#### パラメーター

| パラメーター | 必須 | 型 | デフォルト | 説明 | 例 |
|------------|------|-----|-----------|------|-----|
| `mode` | ✅ 必須 | string | - | 実行モード（固定値） | `"renew"` |
| `certificateIds` | ⭕ オプション | string[] | `[]`（全証明書） | 更新対象の証明書 ID リスト（未指定時は有効なすべての証明書が対象） | `["example-com", "another-domain"]` |
| `dryRun` | ⭕ オプション | boolean | `false` | ドライランモード（実際の変更は行わない） | `true` または `false` |

```bash
# 全ての有効な証明書を処理（自動実行と同じ）
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{"input": {"mode": "renew"}}' \
  --region us-east-1 \
  response.json

# 特定の証明書のみ更新
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "input": {
      "mode": "renew",
      "certificateIds": ["example-com", "another-domain"]
    }
  }' \
  --region us-east-1 \
  response.json

# ドライラン（実際の変更なし）
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "input": {
      "mode": "renew",
      "dryRun": true
    }
  }' \
  --region us-east-1 \
  response.json
```

### ログの確認

```bash
# CloudWatch Logs で確認
aws logs tail /aws/lambda/AcmeToAcmCertificateRenewer --follow --region us-east-1
```

## ワークフロー

### 初回セットアップ（JPRS の場合）

1. **アカウント登録** (register モード)
   - JPRS から EAB 認証情報を取得
   - register モードで ACME アカウントを登録
   - アカウント情報は S3 に自動保存される

2. **証明書取得** (certonly モード)
   - certonly モードで証明書を取得し ACM にインポート
   - 既に登録済みのアカウントを使用するため EAB は不要
   - **自動的に domains.json が作成/更新され、renew モードの対象に追加される**

3. **自動更新** (renew モード)
   - certonly で作成された domains.json に基づいて毎週自動更新
   - 有効期限が近づいた証明書のみ自動更新
   - 必要に応じて手動で domains.json を編集可能

### 証明書の種類とキータイプ

- **RSA 2048-bit** (デフォルト): 広く互換性がある
- **RSA 4096-bit**: より高いセキュリティレベル
- **ECDSA**: 小さい鍵サイズで高いセキュリティ、パフォーマンスも良好

domains.json または certonly ペイロードで `keyType` と `rsaKeySize` を指定できます。

## 設定

### スケジュール変更

デフォルトでは毎週日曜日 午前 2 時（JST）に実行されます。変更するには `bin/acme-to-acm.ts` を編集：

```typescript
new AcmeToAcmStack(app, 'AcmeToAcmStack', {
  scheduleExpression: 'cron(0 10 ? * MON *)', // 毎週月曜 19時JST
  // ...
});
```

### ACME プロバイダー

サポートされているプロバイダー：

1. **JPRS** (`acmeProvider: "jprs"`)
   - JPRS の ACME サーバー
   - URL: `https://acme.amecert.jprs.jp/DV/getDirectory`

2. **Let's Encrypt** (`acmeProvider: "letsencrypt"`)
   - 本番環境用
   - URL: `https://acme-v02.api.letsencrypt.org/directory`

3. **カスタム** (`acmeProvider: "custom"`)
   - 任意の ACME サーバー
   - `acmeServerUrl` で URL を指定

## トラブルシューティング

### 証明書取得失敗

1. **Route53 ホストゾーン ID が正しいか確認**
   ```bash
   aws route53 list-hosted-zones
   ```

2. **IAM 権限を確認**
   - Lambda 実行ロールに Route53 の権限があるか

3. **CloudWatch Logs でエラー詳細を確認**

### ACM インポート失敗

- ACM のリージョンが `us-east-1` であることを確認
- 既存証明書 ARN が正しいか確認

### Docker ビルドエラー

**エラー**: `Failed to find and execute 'docker'`

**原因**: Docker Desktop がインストールされていないか、起動していない

**解決方法**:

1. **Docker Desktop がインストールされているか確認**
   ```bash
   docker --version
   ```
   インストールされていない場合は、[前提条件](#前提条件)セクションのリンクからインストールしてください。

2. **Docker Desktop が起動しているか確認**
   - macOS: メニューバーに Docker アイコンが表示され、"Docker Desktop is running" になっている
   - Windows: システムトレイに Docker アイコンが表示されている

3. **Docker デーモンの動作確認**
   ```bash
   docker ps
   ```
   成功する場合、コンテナ一覧が表示されます。

4. **上記が成功したら、再度デプロイを実行**
   ```bash
   npm run deploy
   ```

**注**: Lambda Container Image のビルドには Docker が必須です。このプロジェクトは Certbot (Python製) を Node.js Lambda 環境で動作させるため、カスタムコンテナイメージを使用しています。

**ローカルでのビルドテスト**:
```bash
# Lambda ディレクトリでビルドテスト
cd lambda
npm run build
docker build -t acme-to-acm-test .
```

## セキュリティ

- ✅ S3 バケットのパブリックアクセスブロック有効
- ✅ S3 バケット暗号化（SSE-S3）
- ✅ IAM 最小権限の原則
- ✅ ACM 証明書と秘密鍵の暗号化保存
- ✅ CloudWatch Logs での監査ログ記録
- ✅ コマンドインジェクション対策（`execFileSync` による引数配列渡し）

## コスト

概算月額コスト（東京リージョン、週1回実行の場合）：

- Lambda: $0.20 〜 $1.00
- S3: $0.10 〜 $0.50
- SNS: $0.01 〜 $0.10
- EventBridge: $0.00（無料枠内）

**合計: 約 $0.30 〜 $2.00/月**

## ライセンス

MIT License

Copyright (c) 2025 株式会社オノコム (Onocom Co., Ltd.)

詳細は [LICENSE](LICENSE) ファイルを参照してください。

## 参考リンク

- [Certbot 公式ドキュメント](https://eff-certbot.readthedocs.io/)
- [JPRS ACME 対応](https://jprs.jp/related-info/guide/058.html)
- [Let's Encrypt](https://letsencrypt.org/)
- [AWS CDK](https://docs.aws.amazon.com/cdk/)
