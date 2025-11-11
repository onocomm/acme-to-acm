#
# ACME to ACM Lambda 関数用 Dockerfile
#
# このファイルは、Certbot を使用して ACME 証明書を取得する Lambda 関数の
# Docker イメージをビルドする。Node.js と Python の両方を必要とするため、
# OS-only base image を使用する特殊な構成となっている。
#
# 重要な設計判断:
# - Base image: public.ecr.aws/lambda/provided:al2023 (OS-only)
# - Runtime-specific image (python:3.13, nodejs:22) は使用しない
# - 理由: OpenSSL 互換性の問題を回避し、両ランタイムを対等に扱うため
#

# AWS Lambda OS-only ベースイメージを使用（Amazon Linux 2023）
#
# なぜ OS-only base image を使うのか:
# 1. Node.js と Python の両方を対等な依存関係として扱う
# 2. runtime-specific image (nodejs:22 など) は openssl-snapsafe-libs を含み、
#    Certbot の cryptography パッケージと互換性がない
# 3. 両ランタイムのバージョンを明示的に管理できる
#
# 重要: このベースイメージを python:3.13 や nodejs:22 などに変更しないこと
# デプロイエラーが発生しても、provided:al2023 の文脈で対処すること
FROM public.ecr.aws/lambda/provided:al2023

# Node.js 22、Python 3.13、およびビルド依存関係をインストール
#
# ランタイム:
# - nodejs: Lambda ハンドラーの実行（TypeScript コンパイル済み JavaScript）
# - npm: Node.js パッケージマネージャー
# - python3.13: Certbot の実行環境
# - python3.13-pip: Python パッケージインストーラー
#
# ビルドツール（Certbot の cryptography パッケージに必要）:
# - cmake: クロスプラットフォームビルドシステム
# - gcc/gcc-c++: C/C++ コンパイラ
# - make: ビルド自動化ツール
# - tar: アーカイブ展開
# - autoconf/automake/libtool: 自動ビルド設定
#
# dnf clean all: イメージサイズ削減のためパッケージキャッシュをクリア
RUN dnf install -y \
    nodejs \
    npm \
    python3.13 \
    python3.13-pip \
    cmake \
    gcc \
    gcc-c++ \
    make \
    tar \
    autoconf \
    automake \
    libtool \
    && dnf clean all

# Certbot と Route53 プラグインを pip でインストール
#
# - certbot: ACME プロトコルクライアント（Let's Encrypt、JPRS などから証明書取得）
# - certbot-dns-route53: Route53 DNS-01 チャレンジプラグイン
#   ドメイン所有権を検証するために Route53 に TXT レコードを自動追加/削除する
#
# --no-cache-dir: pip キャッシュを保存しないことでイメージサイズを削減
RUN pip3.13 install --no-cache-dir \
    certbot \
    certbot-dns-route53

# インストールの検証
# ビルド時に各ツールのバージョンを確認し、正しくインストールされたことを保証
# エラーがある場合はここでビルドが失敗するため、問題を早期発見できる
RUN node --version && python3.13 --version && certbot --version

# 作業ディレクトリを Lambda タスクルートに設定
# ${LAMBDA_TASK_ROOT} は Lambda 環境変数（通常 /var/task）
# 以降のコマンドはこのディレクトリで実行される
WORKDIR ${LAMBDA_TASK_ROOT}

# package.json と package-lock.json をコピーして依存関係をインストール
#
# COPY package*.json: package.json と package-lock.json の両方をコピー
# npm ci: package-lock.json に基づいて確定的なインストールを実行
#   - npm install より高速で再現性が高い
#   - CI/CD 環境に最適
# --only=production: devDependencies をインストールせずサイズを削減
COPY package*.json ./
RUN npm ci --only=production

# AWS Lambda Runtime Interface Client (RIC) をローカルにインストール
#
# RIC は Lambda のカスタムランタイムを実装するためのインターフェース
# OS-only base image では、RIC を使って Node.js ハンドラーを Lambda で実行する
# これにより、Lambda が Node.js コードを適切に起動・管理できる
RUN npm install aws-lambda-ric

# TypeScript コンパイル済みコードをコピー
#
# lambda/src/ の TypeScript コードは、デプロイ前に `npm run build` で
# JavaScript にコンパイルされ、lambda/dist/ に出力される
# このコンパイル済みコードをイメージにコピーし、Lambda で実行する
COPY dist ./dist

# npm キャッシュディレクトリを /tmp/.npm に変更（必須設定）
#
# 問題: npm@8.6.0+ はデフォルトで /home/.npm にキャッシュを書き込む
# Lambda のファイルシステムは /tmp 以外が読み取り専用のため、
# npm/npx を実行すると "EROFS: read-only file system" エラーが発生する
#
# 解決: NPM_CONFIG_CACHE 環境変数で書き込み可能な /tmp/ 配下に変更
# この設定がないと Lambda 初期化時にエラーが発生する
ENV NPM_CONFIG_CACHE=/tmp/.npm

# Lambda 実行時のエントリーポイントを設定
#
# ENTRYPOINT: コンテナ起動時に実行されるコマンド
# /usr/bin/npx aws-lambda-ric を使用して Lambda Runtime Interface Client を起動
# npx は npm パッケージを実行するためのツール
#
# この設定により、Lambda が Node.js ハンドラーを適切に呼び出せる
ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]

# Lambda ハンドラー関数の場所を指定
#
# CMD: ENTRYPOINT に渡される引数（ハンドラーのパス）
# "dist/index.handler" は以下を意味する:
# - dist/index.js ファイルの
# - handler という名前のエクスポートされた関数
#
# Lambda はこの関数をイベント受信時に呼び出す
CMD ["dist/index.handler"]
