# Issue #2 導入・検証記録

対象: [acme-to-acm #2](https://github.com/onocomm/acme-to-acm/issues/2)。基準コミット: `72461099735e54dccaa5337df015cb6eb7e88b18`。
作業日: 2026-10-16。本書は共通修正の記録であり、顧客AWSへの配備、実JPRS登録・発行、DNS変更、CloudFront切替の実施記録ではない。

## 共通修正

- イベント全体、EAB引数、Certbot stdout/stderr、外部例外のmessage/stackをログ・SNS・応答へ出さない。許可した固定エラーコードだけを返す。Certbotのログディレクトリは状態のS3同期対象外。
- certonlyは発行前に設定を取得・検証する。NoSuchKeyだけ初回作成とし、権限、通信、JSON、構造不正では発行も設定書込も停止する。
- 主ドメインの一致で既存IDを再利用し、既存ARN、更新閾値、有効/無効、他証明書と設定の追加フィールドを保持する。旧manual-IDが別ドメインと衝突するときは安定ハッシュを付ける。既存の重複ID/主ドメインは自動統合せず停止する。
- domains.jsonの既存更新はIfMatch、新規作成はIfNoneMatchを使う。renewで初回発行したARNも保存する。連続書込には自分のPutObject応答ETagを使い、後から読んだ別更新のETagを使わない。
- Lambda予約同時実行数を1にし、さらにバケット共通の`locks/certbot.json`をIfNoneMatchで取得する。別関数から同じバケットへ接続しても排他する。解放時は所有者とETagを確認しIfMatchで削除する。ロック前の競合失敗ではCertbotのローカル状態へ触れない。
- Certbot状態を`certbot/.snapshots/<uuid>/`へ保存し、全件成功後に`certbot/.snapshot.json`を切り替える。復元も全件を作業ディレクトリへ取得した後で入れ替える。ListObjectsV2の空ページも含め全ページを辿る。
- symlinkをリンク先文字列とメタデータで保存・復元する。絶対パス、ルート外リンク、パストラバーサルは拒否する。旧フラット形式は読めるが、liveの通常PEMは同じlineage・同じ世代のarchiveの4 PEMすべてと一致した場合だけ相対リンクへ移行する。欠落・不一致・世代混在では停止し、旧ローカル状態を保持する。
- renewは個別失敗を継続しつつstatusCode=500を返す。dryRunと期限内証明書はスキップであり、更新成功数に含めない。メタデータ取得失敗で保存済みのARNを失敗扱いにしない。

## Node.js 24とArchitect 5.2

最新版の`@onocomm/onocomm-cli`をGitHub Packagesから取得し、`onocomm architect get --standard lambda-nodejs24-runtime`で基準5.2を確認した。

本関数はPackageType=Imageであり、Managed Runtime属性を`nodejs24.x`へ変更する構成ではない。OS-only `provided:al2023`を維持し、`nodejs24`/`nodejs24-npm`を明示導入してコンテナ内のNode majorが24でなければビルドを停止する。名前空間付きNode24バイナリからRICを起動することで、基準の目的であるNode24実行を満たす。CloudFront用ACMの要件により既定リージョンは従来のus-east-1を維持する。

root/Lambdaのengines、@types/node、lockfile、.nvmrc、CIを24に合わせた。RICは`4.0.2`をlockfileに固定し、コンテナ内でnative addonをビルドする。無関係な既存SDK/CDK依存の更新は行っていない。ローカルnpm ciではnative scriptsを省略し、Docker内では省略しない。

OSイメージタグとPythonパッケージは従来同様に可変であり、イメージ全体のバイト一致を保証するものではない。Node24のmajorを明示固定し、CIでその時点の組合せを実ビルド・検証する。全依存を不変にする場合は、セキュリティ更新を継続する運用と合わせ別途設計する。

## 環境別設定と権威DNS確認

共通コードへ顧客Zone・ドメイン・EAB・実ARNを埋め込まない。`route53ChallengeZones`をCDK contextへ設定すると、Zoneごとに指定したTXT完全名のUPSERT/DELETEだけを許可する。未指定では既存の全Zone権限を維持するため、顧客導入時は明示設定が必要。

1. 承認対象profileとリージョンを固定し、`aws sts get-caller-identity --profile <profile> --region <region>`でアカウントを照合する。
2. 公開Hosted Zoneを全ページ確認し、SAN全件のchallenge名について最長suffixのZoneを確認する。同名の公開Zoneが複数あれば自動選択を信用せず解消する。
3. `get-hosted-zone`のDelegationSet.NameServersを親ZoneのNS委任・`dig +trace`と照合する。CNAME委任や別Zoneの影響も確認する。
4. SANごとの`_acme-challenge`完全名を列挙する。ワイルドカードの`*.`は除く。対象Zone・名前・TXTのみに制限したsynth差分を確認する。

`route53HostedZoneId`は設定に保持する照合用メタデータで、CertbotへのZone指定引数ではない。Certbotプラグインは公開Zoneから最長suffixを自動探索する。権限の限定だけで実際の権威DNS一致が証明されたとは扱わない。

既定cron `cron(0 17 ? * SUN *)` は月曜02:00 JST。説明のみ訂正し、式の値は変更していない。1バケット1 ACMEアカウントの前提を維持し、別アカウント・別プロバイダーの独立運用には従来どおり別バケット/スタックを使う。

## 検証

実AWSへ接続しないローカル検証で確認した。

| 検証 | 結果 |
| --- | --- |
| root/Lambdaビルド | Node.js v24.4.0で成功 |
| Jest | 7 suites / 89 tests成功 |
| Git基準コミットのsynth | 成功 |
| 修正版の既定設定synth | 成功 |
| Zone/TXT制限を指定したsynth | 成功 |
| コンテナ実ビルド・起動 | Node v24.18.0 / Python 3.13.14 / Certbot 5.8.0 / dns-route53 / RIC呼出し / 実handler InvalidInput応答を確認 |
| Python暗号処理と依存 | SSL OpenSSL 3.5.7 / cryptography 50.0.2 (OpenSSL 4.0.3)、RSA2048/SHA256の署名・検証、pip check成功 |

ダミーEABの正常/異常経路、設定取得の失敗・不正JSON・重複防止、ETag競合、全ページ復元、symlinkと旧形式移行、2証明書を実S3Manager経由で復元後に既存ARNへ再インポートする回帰を含む。CertbotとACM/S3 APIはテストで模擬し、実JPRS発行はしていない。

同じ依存を使い、架空アカウント`000000000000`、us-east-1、認証ファイル無効、`--no-lookups`でGit基準とのテンプレート比較を行った。既定設定で変わったResource PropertiesはLambdaの`Code`と`ReservedConcurrentExecutions`だけ。バケット・IAM・スケジュール・論理IDを維持した。制限設定時のIAM差分はCDKテストで確認した。実AWSに対する`cdk diff`ではない。

```bash
npm ci
npm run build
npm test -- --runInBand
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEPLOY_REGION=us-east-1 npm run synth -- --no-lookups
npm run test:runtime
```

`test:runtime`はlinux/amd64イメージをビルドし、ネットワーク遮断・読み取り専用・非rootの環境でNode/Python/Certbot/Route53 plugin/cryptographyとRIC起動を検証する。実JPRSへは接続しない。

## 配備影響と受入

対象アカウントの現行配備状態、CloudFormation実テンプレート、実ARN、ACMEアカウントは今回未変更。共通修正のsynth比較はGit基準との比較であり、顧客環境の実diffの代わりにはしない。

- 配備承認時に対象profileをSTSで確認し、現行CloudFormationテンプレート、LambdaのImageUri/digest、予約同時実行数、スケジュール、domains.jsonのVersionId/ETag、certbot状態を控える。バックアップには秘密鍵が含まれるため、非公開ストレージだけに保存する。
- バケットの全書込元を更新・停止してから移行する。旧コードは新しいロックと状態ポインタを知らないため、新旧コードを混在実行しない。
- 承認した環境別Route53設定で`cdk diff --profile <profile>`を確認する。証明書ARN/バケットの置換、スケジュールの変更がないことを確認する。
- 実JPRS発行とDNS変更は別承認後に行う。Lambda InvokeのHTTP 200だけで成功扱いせず、FunctionErrorがなく、Payload.statusCode=200、totalFailed=0、対象resultsがsuccess=trueかつskippedではないことを確認する。ACMの既存ARN・SAN・期限とCloudFrontの参照ARNを読み取りで確認する。
- dryRunはS3同期とSNS通知を行い、発行/インポートの試験にはならない。EventBridgeもPayloadの500をLambda例外とは扱わないため、失敗SNSと個別結果を監視する。

## 障害復旧と切り戻し

- ロックは960秒の期限を記録するが、自動削除・自動奪取しない。Lambda強制終了やS3応答不明時は安全側で停止する。全書込元の停止を確認し、所有者・ETag・該当実行の終了を照合してから人間の判断で解除する。期限経過だけを根拠に解除しない。
- 設定の412/409競合では無条件再試行しない。現在の設定とACM ARNを読み取り、どこまで完了したか照合する。ACM import後の設定保存失敗では、新規ARNだけがACMに存在する可能性がある。再発行前に管理タグ・SANと実ARNを確認し、設定を修復する。
- 保存失敗した世代・古い世代は自動削除しない。ロールバックと参照先を確認した後、保持ポリシーに従って整理する。現行ポインタの世代を消すライフサイクルを追加しない。
- コードを戻すだけではS3状態は戻らない。実行とスケジュールを停止し、最新の正常snapshotを復元・検証してから旧コードが読む`certbot/`のフラット配置へエクスポートするか、移行前のS3 VersionId一式へ戻す。旧版の復元にはページング欠陥があるため、`.snapshot.json`と`.snapshots/`はバックアップ確認後にcertbot/外の別prefixへ退避し、旧版の一覧へ混入させない。旧フラット対象が1000件を超える場合は旧版へ戻さず修正版で復旧する。稼働中のACM ARNと設定は照合して保持する。古い設定へ機械的に戻して新しいARNを失わないようにする。
- 旧コンテナdigestとCDKテンプレートを戻し、必要に応じて予約同時実行数も元の値へ戻す。旧版にはEAB露出の問題があるため、EABを入力せず原因修正を優先する。状態と既存ARNを確認した後、承認済みスケジュールで再開する。

## 根拠

- [LambdaコンテナとOS-only image/RIC要件](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
- [AL2023のNode.js名前空間付きパッケージ](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html)
- [AWS Node.js RIC](https://github.com/aws/aws-lambda-nodejs-runtime-interface-client)
- [S3条件付き書込](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Route 53の名前・種類・操作の条件](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/specifying-conditions-route53.html)
- [Certbot Route53プラグインのZone探索](https://github.com/certbot/certbot/blob/main/certbot-dns-route53/src/certbot_dns_route53/_internal/dns_route53.py)
- [Certbot storageのsymlink要件](https://github.com/certbot/certbot/blob/master/certbot/src/certbot/_internal/storage.py)
