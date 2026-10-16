// AWS 認証情報を渡さず、ネットワークを遮断してランタイムと RIC を検証する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.versions.node.split('.')[0], '24', 'Node.js 24 で実行してください');
const root = fileURLToPath(new URL('../', import.meta.url));
const image = 'acme-to-acm:runtime-test';
execFileSync('docker', [
  'build', '--platform', 'linux/amd64', '--provenance=false', '-t', image, 'lambda',
], { cwd: root, stdio: 'inherit' });
const config = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0].Config;
assert.deepEqual(config.Entrypoint, ['/usr/local/bin/acme-entrypoint']);
assert.deepEqual(config.Cmd, ['dist/index.handler']);

// コンテナ内に置く検証用プログラム。Runtime API はループバックで完結する。
const smoke = String.raw`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

assert.match(readFileSync('/etc/os-release', 'utf8'), /VERSION_ID="2023"/);
assert.equal(process.versions.node.split('.')[0], '24');
const python = execFileSync('python3.13', ['--version'], { encoding: 'utf8' }).trim();
assert.match(python, /^Python 3\.13\./);
const crypto = JSON.parse(execFileSync('python3.13', ['-c', [
  'import json, ssl, cryptography',
  'from cryptography.hazmat.primitives import hashes',
  'from cryptography.hazmat.primitives.asymmetric import padding, rsa',
  'from cryptography.hazmat.backends.openssl.backend import backend',
  'key = rsa.generate_private_key(public_exponent=65537, key_size=2048)',
  'message = b"acme-to-acm-runtime-smoke"',
  'signature = key.sign(message, padding.PKCS1v15(), hashes.SHA256())',
  'key.public_key().verify(signature, message, padding.PKCS1v15(), hashes.SHA256())',
  'print(json.dumps({"pythonOpenSSL": ssl.OPENSSL_VERSION, "cryptography": cryptography.__version__, "cryptographyOpenSSL": backend.openssl_version_text(), "signature": "RSA2048/SHA256 passed"}))',
].join('\n')], { encoding: 'utf8' }));
const pipCheck = execFileSync('python3.13', ['-m', 'pip', 'check'], { encoding: 'utf8' }).trim();
const certbot = execFileSync('certbot', ['--version'], { encoding: 'utf8' }).trim();
const plugins = execFileSync('certbot', [
  'plugins', '--text', '--non-interactive',
  '--config-dir', '/tmp/certbot/config', '--work-dir', '/tmp/certbot/work',
  '--logs-dir', '/tmp/certbot/log',
], { encoding: 'utf8' });
assert.match(plugins, /dns-route53/);
const require = createRequire('/var/task/package.json');
assert.equal(typeof require('/var/task/dist/index.js').handler, 'function');
writeFileSync('/tmp/runtime-smoke.js',
  'exports.handler = async event => ({ token: event.token, major: process.versions.node.split(".")[0] });');

async function invoke(handler, event, validate) {
  let ric;
  let nextSent = false;
  let finish;
  let fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/2018-06-01/runtime/invocation/next') {
      if (nextSent) return;
      nextSent = true;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Lambda-Runtime-Aws-Request-Id': 'runtime-smoke',
        'Lambda-Runtime-Deadline-Ms': String(Date.now() + 10000),
        'Lambda-Runtime-Invoked-Function-Arn': 'arn:aws:lambda:ap-northeast-1:000000000000:function:runtime-smoke',
      });
      response.end(JSON.stringify(event));
      return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(202);
      response.end();
      if (request.url === '/2018-06-01/runtime/invocation/runtime-smoke/response') {
        try { validate(JSON.parse(body)); finish(); }
        catch (error) { fail(error); }
      } else {
        fail(new Error('Unexpected Runtime API request: ' + request.url + ' ' + body));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const timeout = setTimeout(() => fail(new Error('RIC invocation timed out')), 20000);
  try {
    ric = spawn('/usr/local/bin/acme-entrypoint', [handler], {
      cwd: '/var/task',
      env: {
        ...process.env,
        AWS_LAMBDA_RUNTIME_API: '127.0.0.1:' + server.address().port,
        AWS_LAMBDA_FUNCTION_NAME: 'runtime-smoke',
        AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
        AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '1024',
        AWS_LAMBDA_LOG_GROUP_NAME: '/aws/lambda/runtime-smoke',
        AWS_LAMBDA_LOG_STREAM_NAME: 'local',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    ric.once('error', fail);
    ric.once('exit', code => fail(new Error('RIC exited before validation: ' + code)));
    await completed;
  } finally {
    clearTimeout(timeout);
    ric?.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
  }
}
await invoke('/tmp/runtime-smoke.handler', { token: 'local-only' }, result => {
  assert.deepEqual(result, { token: 'local-only', major: '24' });
});
await invoke('dist/index.handler', {}, result => {
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.message, 'InvalidInput');
});
console.log(JSON.stringify({ node: process.version, python, ...crypto, pipCheck, certbot,
  plugin: 'dns-route53', ric: 'invocation passed', application: 'InvalidInput/500 passed' }));
`;
execFileSync('docker', [
  'run', '--rm', '-i', '--platform', 'linux/amd64', '--network', 'none',
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=128m', '--user', '1000:1000',
  '--entrypoint', '/usr/bin/node-24', image, '--input-type=module',
], { input: smoke, stdio: ['pipe', 'inherit', 'inherit'], timeout: 120000 });
