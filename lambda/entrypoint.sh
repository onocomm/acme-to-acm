#!/bin/sh
set -eu

# RIC 4 は handler を環境変数から読む。Lambda の image CMD を引き継ぐ。
if [ "$#" -ne 1 ]; then
  echo 'Lambda handler を 1 つ指定してください' >&2
  exit 1
fi
export _HANDLER="$1"
exec /usr/bin/node-24 "${LAMBDA_TASK_ROOT}/node_modules/aws-lambda-ric/index.mjs"
