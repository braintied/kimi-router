#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const ROUTER_PORT = 9920;
const UPSTREAM_PORT = 9921;
const KEY_FILE = '/tmp/kimi-router-v3-keys';
const STATE_FILE = '/tmp/kimi-router-v3-state.json';
const LOG_FILE = '/tmp/kimi-router-v3.jsonl';
const MANAGEMENT_TOKEN = 'test-management-token';
const routerPath = new URL('./router.mjs', import.meta.url).pathname;

const primaryEntry = '# primary@example.com\ntest-primary\n';
const rotatedPrimaryEntry = '# primary@example.com\ntest-primary-rotated\n';
const backupEntry = '# backup@example.com\ntest-backup\n';
const thirdEntry = '# third@example.com\ntest-third\n';

for (const file of [KEY_FILE, STATE_FILE, LOG_FILE]) fs.rmSync(file, { force: true });
fs.writeFileSync(KEY_FILE, primaryEntry + backupEntry, { mode: 0o600 });

const requests = [];

function sendJson(res, status, message, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status < 400 ? { ok: true, ...extra } : { error: { message } }));
}

const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { /* invalid JSON is irrelevant here */ }
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const action = req.url === '/safe-retry' ? 'safe-retry' : payload.action || 'ok';
    requests.push({ key, action, model: payload.model || '*', at: Date.now() });

    if (action === 'invalid-credential' && key === 'test-primary') {
      sendJson(res, 401, 'Invalid API key.');
      return;
    }
    if (action === 'unknown-403' && key === 'test-primary') {
      sendJson(res, 403, 'Forbidden by an account policy.');
      return;
    }
    if (action === 'server-error' && key === 'test-primary') {
      sendJson(res, 503, 'Temporary upstream failure.');
      return;
    }
    if (action === 'network-drop' && key === 'test-primary') {
      req.socket.destroy();
      return;
    }
    if (action === 'safe-retry' && key === 'test-primary') {
      sendJson(res, 503, 'Temporary upstream failure.');
      return;
    }
    if (action === 'reset-header' && key === 'test-primary') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1',
      });
      res.end(JSON.stringify({ error: { message: 'You reached the 5-hour usage limit for this period.' } }));
      return;
    }

    if (action === 'overload') {
      sendJson(res, 429, 'The Kimi engine is currently overloaded.');
      return;
    }
    if (action === 'url-risk') {
      sendJson(res, 403, 'The URL was rejected because it poses a URL security risk.');
      return;
    }
    if (action === 'membership' && key === 'test-primary') {
      sendJson(res, 402, 'Unable to verify your membership. Please try again later.');
      return;
    }
    if (action === 'capability' && key === 'test-primary' && payload.model === 'k3[1m]') {
      sendJson(res, 401, 'Your plan does not have permission to use model k3[1m].');
      return;
    }
    if (action === 'race-fail' && key === 'test-primary') {
      setTimeout(() => sendJson(res, 403, "You've reached your usage limit for this billing cycle."), 50);
      return;
    }
    if (action === 'race-success' && key === 'test-primary') {
      setTimeout(() => sendJson(res, 200, '', { used: key }), 120);
      return;
    }
    if (action === 'race-success-old' && key === 'test-primary') {
      setTimeout(() => sendJson(res, 200, '', { used: key }), 120);
      return;
    }
    if (action === 'race-fail-new' && key === 'test-primary') {
      setTimeout(() => sendJson(res, 403, "You've reached your usage limit for this billing cycle."), 50);
      return;
    }
    if (action === 'hold') {
      setTimeout(() => sendJson(res, 200, '', { used: key }), 300);
      return;
    }
    if (action === 'huge-error') {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('x'.repeat(4096));
      return;
    }
    if (action === 'slow-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: last\n\n'), 300);
      return;
    }
    sendJson(res, 200, '', { used: key });
  });
});

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

let stderr = '';
const router = spawn(process.execPath, [routerPath], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(ROUTER_PORT),
    KIMI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    KIMI_API_KEYS: '',
    KIMI_KEYS_FILE: KEY_FILE,
    KIMI_ROUTER_STATE: STATE_FILE,
    KIMI_LOG_FILE: LOG_FILE,
    KIMI_LOG_STDOUT: '0',
    KIMI_MANAGEMENT_TOKEN: MANAGEMENT_TOKEN,
    KIMI_MAX_INFLIGHT_PER_KEY: '2',
    KIMI_MAX_QUEUE_DEPTH: '1',
    KIMI_QUEUE_TIMEOUT_MS: '2000',
    KIMI_ERROR_BODY_MAX_BYTES: '128',
    KIMI_RECOVERY_PROBE_INITIAL_MS: '60000',
    KIMI_EXPLORATION_INTERVAL_MS: '3600000',
    KIMI_DRAIN_TIMEOUT_MS: '3000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
router.stderr.on('data', (chunk) => { stderr += chunk; });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch { /* service may still be starting */ }
    await sleep(50);
  }
  return false;
}

const base = `http://127.0.0.1:${ROUTER_PORT}`;
const started = await waitUntil(async () => (await fetch(`${base}/healthz`)).status === 200);
if (!started) {
  router.kill('SIGKILL');
  upstream.close();
  throw new Error(`router did not start: ${stderr}`);
}

let failures = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

function post(action, model = 'k3') {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, model }),
  });
}

const managementHeaders = { authorization: `Bearer ${MANAGEMENT_TOKEN}` };

async function status() {
  return (await fetch(`${base}/status`, { headers: managementHeaders })).json();
}

async function reset() {
  await fetch(`${base}/reset`, { method: 'POST', headers: managementHeaders });
}

async function prefer(label = 'primary@example.com') {
  await fetch(`${base}/prefer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...managementHeaders },
    body: JSON.stringify({ label }),
  });
}

console.log('running router v3 tests...');

const unauthorizedStatus = await fetch(`${base}/status`);
const wrongTokenStatus = await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong-token' } });
const authorizedStatus = await fetch(`${base}/status`, { headers: managementHeaders });
check('management status requires authentication', unauthorizedStatus.status === 401 && wrongTokenStatus.status === 401);
check('management status accepts the installed bearer credential', authorizedStatus.status === 200 && authorizedStatus.headers.get('cache-control') === 'no-store');

await prefer();
let before = requests.length;
const overload = await post('overload');
check('engine overload passes through without spraying the key pool', overload.status === 429 && requests.length - before === 1);
const overloadStatus = await status();
check('provider overload opens a short provider circuit', overloadStatus.summary.providerCircuitReason.includes('overloaded'));

await reset();
await prefer();
before = requests.length;
const urlRisk = await post('url-risk');
const urlRiskStatus = await status();
check('URL security rejection is request-scoped and not retried', urlRisk.status === 403 && requests.length - before === 1);
check('request-scoped rejection leaves the account healthy', urlRiskStatus.keys.find((k) => k.label === 'primary@example.com').available);

await reset();
await prefer();
before = requests.length;
const unknownForbidden = await post('unknown-403');
const unknownForbiddenStatus = await status();
check('unknown 403 is request-scoped and not retried', unknownForbidden.status === 403 && requests.length - before === 1);
check('unknown 403 does not poison account health', unknownForbiddenStatus.keys.find((k) => k.label === 'primary@example.com').available);

await reset();
await prefer();
before = requests.length;
const invalidCredential = await post('invalid-credential');
const invalidCredentialBody = await invalidCredential.json();
const invalidCredentialStatus = await status();
const rejectedCredential = invalidCredentialStatus.keys.find((k) => k.label === 'primary@example.com');
check('invalid credential fails over to another account', invalidCredential.status === 200 && invalidCredentialBody.used === 'test-backup' && requests.length - before === 2);
check('credential rejection is isolated from account quota state', rejectedCredential.health === 'credential-rejected' && rejectedCredential.credentialCooldownUntil !== null && rejectedCredential.cooldownUntil === null);
check('status separates account and credential identities', rejectedCredential.accountId === 'primary@example.com' && typeof rejectedCredential.credentialId === 'string' && invalidCredentialStatus.summary.accounts === 2);

await reset();
await prefer();
before = requests.length;
const serverError = await post('server-error');
const serverErrorStatus = await status();
check('unsafe POST is not replayed after upstream 5xx', serverError.status === 503 && serverError.headers.get('x-router-replay-suppressed') === 'true' && requests.length - before === 1);
check('5xx still opens a transient health circuit', !serverErrorStatus.keys.find((k) => k.label === 'primary@example.com').available);

await reset();
await prefer();
before = requests.length;
const networkDrop = await post('network-drop');
check('unsafe POST is not replayed after an ambiguous network failure', networkDrop.status === 502 && networkDrop.headers.get('x-router-replay-suppressed') === 'true' && requests.length - before === 1);

await reset();
await prefer();
before = requests.length;
const safeRetry = await fetch(`${base}/safe-retry`);
const safeRetryBody = await safeRetry.json();
check('safe GET can fail over after upstream 5xx', safeRetry.status === 200 && safeRetryBody.used === 'test-backup' && requests.length - before === 2);

await reset();
await prefer();
const resetHeader = await post('reset-header');
const resetHeaderBody = await resetHeader.json();
const resetHeaderStatus = await status();
const resetHeaderPrimary = resetHeaderStatus.keys.find((k) => k.label === 'primary@example.com');
check('rate-limit reset header drives quota failover', resetHeader.status === 200 && resetHeaderBody.used === 'test-backup');
check('rate-limit reset header sets an exact short cooldown', resetHeaderPrimary.cooldownRemainingMs > 0 && resetHeaderPrimary.cooldownRemainingMs <= 1500 && /rate-limit reset in 1s/.test(resetHeaderPrimary.cooldownReason));
check('rate-limit telemetry exposes the computed reset time', typeof resetHeaderPrimary.rateLimit.resetAt === 'string');

await reset();
await prefer();
before = requests.length;
const membership = await post('membership');
const membershipBody = await membership.json();
const membershipStatus = await status();
check('temporary membership verification failure rotates to another account', membership.status === 200 && membershipBody.used === 'test-backup' && requests.length - before === 2);
check('402 verification failure gets a transient account circuit', /membership verification temporarily/.test(membershipStatus.keys.find((k) => k.label === 'primary@example.com').cooldownReason));

await reset();
await prefer();
const capability = await post('capability', 'k3[1m]');
const capabilityBody = await capability.json();
await prefer();
const standard = await post('ok', 'k3');
const standardBody = await standard.json();
const capabilityStatus = await status();
const primary = capabilityStatus.keys.find((k) => k.label === 'primary@example.com');
check('1M capability denial fails over to a compatible account', capability.status === 200 && capabilityBody.used === 'test-backup');
check('model circuit does not disable the same account for standard K3', standard.status === 200 && standardBody.used === 'test-primary');
check('status exposes the model-specific circuit', primary.capabilityCooldowns['k3[1m]']?.reason.includes('capability'));

await reset();
await prefer();
const raceFail = post('race-fail');
await sleep(5);
const raceSuccess = post('race-success');
const [raceFailResponse, raceSuccessResponse] = await Promise.all([raceFail, raceSuccess]);
await Promise.all([raceFailResponse.text(), raceSuccessResponse.text()]);
const raceStatus = await status();
const racePrimary = raceStatus.keys.find((k) => k.label === 'primary@example.com');
check('concurrent quota failure still fails its request over', raceFailResponse.status === 200);
check('newer concurrent success supersedes the account failure', raceSuccessResponse.status === 200 && racePrimary.available && racePrimary.pendingFailure === null);

await reset();
await prefer();
const olderSuccess = post('race-success-old');
await sleep(5);
const newerFailure = post('race-fail-new');
const [olderSuccessResponse, newerFailureResponse] = await Promise.all([olderSuccess, newerFailure]);
await Promise.all([olderSuccessResponse.text(), newerFailureResponse.text()]);
const reverseRaceStatus = await status();
const reverseRacePrimary = reverseRaceStatus.keys.find((k) => k.label === 'primary@example.com');
check('newer concurrent failure still fails its request over', newerFailureResponse.status === 200);
check(
  'older successful stream cannot reopen an account after a newer quota failure',
  olderSuccessResponse.status === 200 && !reverseRacePrimary.available &&
    /billing-cycle quota exhausted/.test(reverseRacePrimary.cooldownReason)
);

await reset();
await prefer();
before = requests.length;
const loadResponses = await Promise.all([post('hold'), post('hold'), post('hold')]);
await Promise.all(loadResponses.map((response) => response.text()));
const loadKeys = requests.slice(before).map((request) => request.key);
check('per-key concurrency cap spreads load across healthy accounts', loadKeys.filter((key) => key === 'test-primary').length === 2 && loadKeys.includes('test-backup'));
const loadStatus = await status();
check('completed responses release every in-flight attempt exactly once', loadStatus.summary.inFlight === 0);

await reset();
const saturated = [post('hold'), post('hold'), post('hold'), post('hold')];
await sleep(40);
const queued = post('hold');
await sleep(40);
const rejected = await post('hold');
check('bounded queue rejects excess work instead of growing unbounded', rejected.status === 503);
const completedSaturated = await Promise.all([...saturated, queued]);
await Promise.all(completedSaturated.map((response) => response.text()));
check('one queued request resumes when capacity is released', completedSaturated.every((response) => response.status === 200));

fs.writeFileSync(KEY_FILE, primaryEntry + backupEntry + thirdEntry, { mode: 0o600 });
const autoReloaded = await waitUntil(async () => (await status()).summary.total === 3);
check('key file changes hot-reload automatically', autoReloaded);

await reset();
await prefer();
const credentialRotationStream = await post('slow-stream');
await sleep(30);
fs.writeFileSync(KEY_FILE, rotatedPrimaryEntry + backupEntry + thirdEntry, { mode: 0o600 });
const credentialReload = await fetch(`${base}/reload`, { method: 'POST', headers: managementHeaders });
const credentialReloadBody = await credentialReload.json();
await prefer();
const afterCredentialRotation = await post('ok');
const afterCredentialRotationBody = await afterCredentialRotation.json();
const credentialRotationBody = await credentialRotationStream.text();
const credentialRotationDrained = await waitUntil(async () =>
  (await status()).keys.filter((key) => key.label === 'primary@example.com').length === 1
);
check(
  'credential hot rotation sends new requests through the replacement secret',
  credentialReloadBody.added === 1 && credentialReloadBody.retiring === 1 &&
    afterCredentialRotation.status === 200 && afterCredentialRotationBody.used === 'test-primary-rotated'
);
check(
  'proxy session survives credential rotation while its original stream drains',
  credentialRotationBody.includes('data: last') && credentialRotationDrained
);

await reset();
await prefer();
const retiringRequest = post('hold');
await sleep(40);
fs.writeFileSync(KEY_FILE, backupEntry + thirdEntry, { mode: 0o600 });
const reloadResponse = await fetch(`${base}/reload`, { method: 'POST', headers: managementHeaders });
const reloadBody = await reloadResponse.json();
const duringRetire = await status();
const retiringKey = duringRetire.keys.find((k) => k.label === 'primary@example.com');
check('removed in-flight key drains instead of being cut off', reloadBody.retiring === 1 && retiringKey?.retiring && retiringKey.inFlight === 1);
await (await retiringRequest).text();
const retired = await waitUntil(async () => !(await status()).keys.some((k) => k.label === 'primary@example.com'));
check('drained removed key leaves the live pool', retired);

await reset();
const huge = await post('huge-error');
const hugeBody = await huge.text();
check('buffered upstream error bodies are capped', huge.headers.get('x-router-error-body-truncated') === 'true' && Buffer.byteLength(hugeBody) === 128);

await reset();
const stream = await post('slow-stream');
await sleep(30);
router.kill('SIGTERM');
await sleep(60);
check('SIGTERM starts a drain without killing an active stream', router.exitCode === null);
const streamBody = await stream.text();
const routerExit = router.exitCode ?? await new Promise((resolve) => router.once('exit', resolve));
if (!streamBody.includes('data: last') || routerExit !== 0) {
  console.log(`    drain detail: exit=${String(routerExit)} body=${JSON.stringify(streamBody)} stderr=${JSON.stringify(stderr)}`);
}
check('graceful drain finishes the stream and exits cleanly', streamBody.includes('data: last') && routerExit === 0);

await new Promise((resolve) => upstream.close(resolve));
for (const file of [KEY_FILE, STATE_FILE, LOG_FILE]) fs.rmSync(file, { force: true });

if (failures > 0) {
  console.error(`${failures} router v3 test(s) failed`);
  process.exit(1);
}
console.log('ALL V3 TESTS PASSED');
