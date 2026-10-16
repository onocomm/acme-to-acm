# Node.js と Python を対等に管理するため AL2023 OS-only image を維持する。
# Runtime-specific image への変更は Certbot/OpenSSL 互換性を再評価すること。
FROM public.ecr.aws/lambda/provided:al2023

# 無指定の nodejs/npm は既定 major に依存するため使用しない。
RUN dnf install -y \
    nodejs24 \
    nodejs24-npm \
    python3.13 \
    python3.13-pip \
    cmake \
    gcc \
    gcc-c++ \
    make \
    tar \
    xz \
    autoconf \
    automake \
    libtool \
    && ln -s /usr/bin/node-24 /usr/local/bin/node \
    && ln -s /usr/bin/npm-24 /usr/local/bin/npm \
    && ln -s /usr/bin/npx-24 /usr/local/bin/npx \
    && dnf clean all

RUN pip3.13 install --no-cache-dir certbot certbot-dns-route53

# パッケージ名に加え実際の major を検査し、暗黙のバージョン変更を検知する。
RUN node -e "if (process.versions.node.split('.')[0] !== '24') process.exit(1)" \
    && node --version \
    && npm --version \
    && python3.13 --version \
    && certbot --version

WORKDIR ${LAMBDA_TASK_ROOT}

# RIC も package-lock.json からインストールし、ビルド中に依存を更新しない。
COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY --chmod=755 entrypoint.sh /usr/local/bin/acme-entrypoint

# Lambda の読み取り専用ファイルシステムに対応する。
ENV NPM_CONFIG_CACHE=/tmp/.npm

# 名前空間付き Node24 とインストール済み RIC を直接起動する。
# npx による実行時ダウンロードや別 major の選択を防ぐ。
ENTRYPOINT ["/usr/local/bin/acme-entrypoint"]
CMD ["dist/index.handler"]
