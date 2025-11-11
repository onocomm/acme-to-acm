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
│  - Node.js v22      │
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
- Docker (Lambda イメージビルド用)
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

## 使い方

このシステムは3つのモードで動作します：

- **register**: ACME アカウントの登録（EAB 認証）
- **certonly**: 証明書の手動取得とACMインポート
- **renew**: domains.json に基づく自動更新（週次スケジュール）

### Mode 1: register（アカウント登録）

JPRS などの EAB が必要なプロバイダーで最初にアカウントを登録します。

```bash
# JPRS から一時的に発行された EAB 認証情報を使用
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "mode": "register",
    "email": "admin@example.com",
    "server": "https://acme.jprs.jp/directory",
    "eabKid": "YOUR_TEMPORARY_EAB_KID",
    "eabHmacKey": "YOUR_TEMPORARY_EAB_HMAC_KEY"
  }' \
  --region us-east-1 \
  response.json

# 実行結果を確認
cat response.json
```

**注意**: EAB 認証情報は一時的なもので、登録後は無効化されます。

### Mode 2: certonly（証明書の手動取得）

ペイロードで指定したドメインの証明書を取得し、ACM にインポートします。

```bash
# 新規証明書の取得
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "mode": "certonly",
    "domains": ["example.com", "*.example.com"],
    "email": "admin@example.com",
    "server": "https://acme.jprs.jp/directory",
    "route53HostedZoneId": "Z1234567890ABC",
    "keyType": "rsa",
    "rsaKeySize": 2048
  }' \
  --region us-east-1 \
  response.json

# 既存 ACM 証明書への再インポート
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "mode": "certonly",
    "domains": ["example.com", "*.example.com"],
    "email": "admin@example.com",
    "server": "https://acme.jprs.jp/directory",
    "route53HostedZoneId": "Z1234567890ABC",
    "acmCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/existing-cert-id",
    "keyType": "rsa",
    "rsaKeySize": 2048,
    "forceRenewal": true
  }' \
  --region us-east-1 \
  response.json

# ECDSA 鍵を使用した証明書の取得
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "mode": "certonly",
    "domains": ["test.example.org"],
    "email": "webmaster@example.org",
    "server": "https://acme-v02.api.letsencrypt.org/directory",
    "route53HostedZoneId": "ZLETENCRYPT456",
    "keyType": "ecdsa"
  }' \
  --region us-east-1 \
  response.json
```

### Mode 3: renew（自動更新）

domains.json の設定に基づいて証明書を更新します（週次スケジュールで自動実行）。

```bash
# 全ての有効な証明書を処理（自動実行と同じ）
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{"mode": "renew"}' \
  --region us-east-1 \
  response.json

# 特定の証明書のみ更新
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "mode": "renew",
    "certificateIds": ["example-com", "another-domain"]
  }' \
  --region us-east-1 \
  response.json

# ドライラン（実際の変更なし）
aws lambda invoke \
  --function-name AcmeToAcmCertificateRenewer \
  --payload '{
    "mode": "renew",
    "dryRun": true
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
   - URL: `https://acme.jprs.jp/directory`

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

## コスト

概算月額コスト（東京リージョン、週1回実行の場合）：

- Lambda: $0.20 〜 $1.00
- S3: $0.10 〜 $0.50
- SNS: $0.01 〜 $0.10
- EventBridge: $0.00（無料枠内）

**合計: 約 $0.30 〜 $2.00/月**

## ライセンス

MIT

## 参考リンク

- [Certbot 公式ドキュメント](https://eff-certbot.readthedocs.io/)
- [JPRS ACME 対応](https://jprs.jp/related-info/guide/058.html)
- [Let's Encrypt](https://letsencrypt.org/)
- [AWS CDK](https://docs.aws.amazon.com/cdk/)
