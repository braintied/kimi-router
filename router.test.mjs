#!/usr/bin/env node
/**
 * kimi-key-router.test.mjs
 *
 * Self-test for kimi-key-router.mjs. Spins up a mock Moonshot upstream that
 * 429s the first key (5-hour message), 429s the second key with a "weekly"
 * message when the request body contains "weekly-trigger", and 200s
 * otherwise. Verifies the router's failover, cooldown, and reset behavior.
 *
 * Run: node ~/kimi-key-router.test.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const MOCK_PORT = 9911;
const ROUTER_PORT = 9910;
const STATE = '/tmp/kimi-router-test-state.json';
const KEYS = '/tmp/kimi-router-test-keys';
fs.rmSync(STATE, { force: true });
fs.writeFileSync(
  KEYS,
  '# label: primary@example.com\ntest-key-1\n\n# backup@example.com\ntest-key-2\n',
  { mode: 0o600 }
);

const seenAuth = [];
const seenXApiKeys = [];

const mock = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  seenAuth.push(auth);
  seenXApiKeys.push(req.headers['x-api-key']);
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    // Path-triggered behaviors (any key) for streaming & retry-after tests
    if (req.url === '/sse-ok') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 100);
      return;
    }
    if (req.url === '/sse-abort') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: chunk-1\n\n');
      setTimeout(() => res.destroy(new Error('upstream exploded')), 150);
      return;
    }
    if (req.url === '/sse-slow') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      const ticker = setInterval(() => res.write('data: tick\n\n'), 200);
      res.on('close', () => clearInterval(ticker));
      return;
    }
    if (req.url === '/retry-after-seconds') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    if (req.url === '/retry-after-date') {
      const when = new Date(Date.now() + 7_200_000).toUTCString();
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': when });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    if (req.url === '/billing-cycle-403') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: "You've reached your usage limit for this billing cycle." },
      }));
      return;
    }
    if (body.includes('slow-recovery-success')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, used: auth }));
      }, 150);
      return;
    }
    if (auth === 'Bearer test-key-1' && !body.includes('allow-key-1')) {
      const reject = () => {
        res.writeHead(429, {
          'content-type': 'application/json',
          ...(body.includes('five-hour-retry-after') ? { 'retry-after': '1' } : {}),
        });
        res.end(JSON.stringify({ error: { message: 'You have reached your 5 hour rate limit' } }));
      };
      if (body.includes('slow-recovery-fail')) setTimeout(reject, 150);
      else reject();
      return;
    }
    if (auth === 'Bearer test-key-2' && body.includes('weekly-trigger')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'weekly usage limit reached for this plan' } }));
      return;
    }
    if (body.includes('bad-request-trigger')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request' } }));
      return;
    }
    const remaining = auth === 'Bearer test-key-1' ? '25' : '80';
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': remaining,
      'x-ratelimit-reset': '3600',
    });
    res.end(JSON.stringify({ ok: true, used: auth }));
  });
});

await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const routerPath = new URL('./router.mjs', import.meta.url).pathname;
const router = spawn(process.execPath, [routerPath], {
  env: {
    ...process.env,
    PORT: String(ROUTER_PORT),
    KIMI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    KIMI_API_KEYS: '',
    KIMI_KEYS_FILE: KEYS,
    KIMI_ROUTER_STATE: STATE,
    KIMI_LOG_FILE: '/tmp/kimi-router-test.jsonl',
    KIMI_LOG_STDOUT: '0',
    KIMI_MANAGEMENT_TOKEN: '',
    KIMI_MAX_BODY_BYTES: '64',
    KIMI_EXPLORATION_INTERVAL_MS: '3600000',
    KIMI_PREFERENCE_TTL_MS: '60000',
    KIMI_COOLDOWN_5H_MS: '400',
    KIMI_RECOVERY_PROBE_INITIAL_MS: '100',
    KIMI_RECOVERY_PROBE_MAX_MS: '800',
  },
  stdio: 'inherit',
});
let routerExited = false;
router.on('exit', () => {
  routerExited = true;
});

await new Promise((resolve) => setTimeout(resolve, 800));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}`);
  }
}

function post(payload) {
  return fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer client-token',
      'x-api-key': 'client-key',
    },
    body: JSON.stringify(payload),
  });
}

console.log('running router self-test...');

// 1. key-1 429s (5h) → router should transparently retry with key-2
const r1 = await post({ hello: 'world' });
const j1 = await r1.json();
check('falls over to key-2 on 5-hour 429', r1.status === 200 && j1.used === 'Bearer test-key-2');
check(
  'replaces both upstream authentication headers',
  seenAuth[0] === 'Bearer test-key-1' &&
    seenXApiKeys[0] === 'test-key-1' &&
    seenAuth[1] === 'Bearer test-key-2' &&
    seenXApiKeys[1] === 'test-key-2'
);

// 2. key-1 is now cooling → next request must not touch it again
const key1HitsBefore = seenAuth.filter((a) => a === 'Bearer test-key-1').length;
const r2 = await post({ hello: 'again' });
await r2.json();
const key1HitsAfter = seenAuth.filter((a) => a === 'Bearer test-key-1').length;
check('cooling key is skipped on subsequent requests', key1HitsAfter === key1HitsBefore);

// 3. key-2 weekly-429s → all keys down → client gets 429 + retry-after
const r3 = await post({ msg: 'weekly-trigger' });
check('all keys exhausted returns 429', r3.status === 429);
const retryAfter = Number(r3.headers.get('retry-after'));
check('retry-after header present and sane', Number.isFinite(retryAfter) && retryAfter > 0);
check('exhausted response flagged', r3.headers.get('x-router-all-keys-cooling') === 'true');

// 4. /status reflects the cooldown reasons
const statusRes = await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`);
const status = await statusRes.json();
check('key-1 marked as 5-hour limit', /5-hour/.test(status.keys[0].cooldownReason));
check('key-2 marked as weekly limit', /weekly/.test(status.keys[1].cooldownReason));
check('both keys unavailable', status.keys.every((k) => !k.available));
check(
  'file comments become sanitized account labels',
  status.keys[0].label === 'primary@example.com' && status.keys[1].label === 'backup@example.com'
);
check(
  'status includes pool summary and slots',
  status.summary.total === 2 && status.summary.available === 0 &&
    status.keys[0].slot === 1 && status.keys[1].slot === 2
);
check(
  'status exposes adaptive health and selection metadata',
  status.summary.strategy === 'adaptive-health-v3' &&
    typeof status.summary.selectionReason === 'string' &&
    status.keys.every((k) => typeof k.health === 'string')
);
check(
  '5-hour quota starts a persisted strict timer',
  status.keys[0].recoveryRequired &&
    status.keys[0].cooldownRemainingMs > 200 &&
    status.keys[0].cooldownRemainingMs <= 400 &&
    status.keys[0].nextRecoveryProbeAt === status.keys[0].cooldownUntil
);

// 4b. Guessed weekly cooldowns still get conservative real-traffic probes,
// while an explicit five-hour quota is not touched before its timer expires.
const key1HitsBeforeTimer = seenAuth.filter((a) => a === 'Bearer test-key-1').length;
await sleep(130);
const recovered1 = await post({ hello: 'allow-key-1' });
const recovered1Body = await recovered1.json();
const recovered1Status = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check(
  'due cooled key is rechecked using real traffic',
  recovered1.status === 200 && recovered1Body.used === 'Bearer test-key-2'
);
check(
  'successful recovery clears the cooldown immediately',
  recovered1Status.keys[1].available &&
    recovered1Status.keys[1].cooldownUntil === null &&
    recovered1Status.keys[1].nextRecoveryProbeAt === null
);
check(
  '5-hour account is not probed before its timer',
  seenAuth.filter((a) => a === 'Bearer test-key-1').length === key1HitsBeforeTimer &&
    recovered1Status.keys[0].recoveryRequired
);

await sleep(300);
const timerRecovery = await post({ hello: 'allow-key-1' });
const timerRecoveryBody = await timerRecovery.json();
const timerRecoveryStatus = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check(
  'first request after the 5-hour timer performs the recovery probe',
  timerRecovery.status === 200 &&
    timerRecoveryBody.used === 'Bearer test-key-1' &&
    timerRecoveryStatus.keys[0].available &&
    !timerRecoveryStatus.keys[0].recoveryRequired
);

// 4c. A failed recovery check is invisible to the client: the request falls
// through to a healthy key and the failed account backs off before trying again.
await fetch(`http://127.0.0.1:${ROUTER_PORT}/prefer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'backup@example.com', ttlMs: 60_000 }),
});
await post({ msg: 'weekly-trigger allow-key-1' });
await sleep(130);
const key2HitsBeforeRecovery = seenAuth.filter((a) => a === 'Bearer test-key-2').length;
const failedRecovery = await post({ msg: 'weekly-trigger allow-key-1' });
const failedRecoveryBody = await failedRecovery.json();
const failedRecoveryStatus = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check(
  'failed recovery probe transparently falls over to a healthy key',
  failedRecovery.status === 200 &&
    failedRecoveryBody.used === 'Bearer test-key-1' &&
    seenAuth.filter((a) => a === 'Bearer test-key-2').length === key2HitsBeforeRecovery + 1
);
check(
  'failed recovery probe increases its backoff',
  failedRecoveryStatus.keys[1].recoveryProbeBackoffMs === 200 &&
    failedRecoveryStatus.keys[1].nextRecoveryProbeAt !== null
);
check(
  'successful responses capture optional rate-limit telemetry',
  status.keys[1].rateLimit?.limit === 100 && status.keys[1].rateLimit?.remaining === 80
);

// 5. /reset clears cooldowns and traffic flows again
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });
const r5 = await post({ hello: 'allow-key-1 post-reset' });
// Keep the primary healthy so the preference test below is deterministic.
check('reset restores availability', r5.status === 200);

// 5b. An operator can temporarily prefer a labelled account without disabling failover.
const preferRes = await fetch(`http://127.0.0.1:${ROUTER_PORT}/prefer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'primary@example.com', ttlMs: 60_000 }),
});
const prefer = await preferRes.json();
check(
  'temporary preference accepts an account label',
  preferRes.status === 200 && prefer.preferredLabel === 'primary@example.com'
);
const preferredRequest = await post({ hello: 'allow-key-1' });
const preferredBody = await preferredRequest.json();
check(
  'temporary preference immediately selects that account',
  preferredRequest.status === 200 && preferredBody.used === 'Bearer test-key-1'
);
const preferredStatus = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check(
  'status explains the temporary operator preference',
  preferredStatus.summary.activeLabel === 'primary@example.com' &&
    preferredStatus.summary.preferredLabel === 'primary@example.com'
);
await fetch(`http://127.0.0.1:${ROUTER_PORT}/prefer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"label":null}',
});

// 5d. Only one recovery probe may be in flight across concurrent sessions.
// Other requests use the healthy key instead of stampeding the cooled account.
await fetch(`http://127.0.0.1:${ROUTER_PORT}/prefer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'primary@example.com', ttlMs: 60_000 }),
});
await post({ hello: 'cool-primary-again' });
await sleep(430);
const key1HitsBeforeConcurrent = seenAuth.filter((a) => a === 'Bearer test-key-1').length;
const concurrentRecovery = await Promise.all([
  post({ hello: 'slow-recovery-fail' }),
  post({ hello: 'slow-recovery-fail' }),
  post({ hello: 'slow-recovery-fail' }),
]);
const concurrentBodies = await Promise.all(concurrentRecovery.map((r) => r.json()));
const key1HitsAfterConcurrent = seenAuth.filter((a) => a === 'Bearer test-key-1').length;
check(
  'concurrent sessions share a single recovery probe',
  key1HitsAfterConcurrent === key1HitsBeforeConcurrent + 1
);
check(
  'concurrent requests keep flowing through the healthy key',
  concurrentRecovery.every((r) => r.status === 200) &&
    concurrentBodies.every((body) => body.used === 'Bearer test-key-2')
);
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });

// 5e. If every other account is cooling while the sole real-traffic recovery
// probe is in flight, concurrent sessions wait for its result instead of
// receiving a false "all keys cooling" response.
await fetch(`http://127.0.0.1:${ROUTER_PORT}/billing-cycle-403`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
await sleep(130);
const recoveringRequest = post({ hello: 'slow-recovery-success' });
await sleep(25);
const waitingRequest = post({ hello: 'slow-recovery-success' });
const recoveredConcurrent = await Promise.all([recoveringRequest, waitingRequest]);
const recoveredConcurrentBodies = await Promise.all(recoveredConcurrent.map((r) => r.json()));
check(
  'concurrent request waits for the only recovering account',
  recoveredConcurrent.every((r) => r.status === 200) &&
    recoveredConcurrentBodies.every((body) => typeof body.used === 'string')
);
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });

// Exact provider reset metadata overrides the conservative five-hour fallback.
await fetch(`http://127.0.0.1:${ROUTER_PORT}/prefer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'primary@example.com', ttlMs: 60_000 }),
});
const exactTimer = await post({ hello: 'five-hour-retry-after' });
await exactTimer.json();
const exactTimerStatus = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check(
  '5-hour timer honors an exact Retry-After',
  exactTimer.status === 200 &&
    exactTimerStatus.keys[0].recoveryRequired &&
    exactTimerStatus.keys[0].cooldownRemainingMs > 700 &&
    exactTimerStatus.keys[0].cooldownRemainingMs <= 1_000 &&
    /retry-after 1s/.test(exactTimerStatus.keys[0].cooldownReason)
);
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });

// 5c. Kimi Code's documented 403 billing-cycle response is a quota cooldown,
// not an invalid key. The router checks the next account transparently.
const quota403 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/billing-cycle-403`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const quotaStatus = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check('billing-cycle 403 exhausts the pool after checking every key', quota403.status === 403);
check(
  'billing-cycle 403 is classified as quota-limited rather than rejected',
  quotaStatus.keys.every((k) =>
    k.health === 'quota-limited' && /billing-cycle quota exhausted/.test(k.cooldownReason)
  )
);
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });

// 6. non-rotating 4xx passes through untouched (request problem, not key problem)
const r6 = await post({ hello: 'bad-request-trigger' });
check('400 passes through without rotation', r6.status === 400);

// 7. DNS-rebinding guard: requests addressed to a foreign Host are rejected
const r7 = await new Promise((resolve, reject) => {
  const req = http.request(
    {
      host: '127.0.0.1',
      port: ROUTER_PORT,
      path: '/status',
      headers: { host: 'evil.example:9910' },
    },
    resolve
  );
  req.on('error', reject);
  req.end();
});
check('foreign Host header rejected with 403', r7.statusCode === 403);
r7.resume();

// 8. cross-origin browser call is rejected
const r8 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, {
  method: 'POST',
  headers: { origin: 'https://evil.example' },
});
check('foreign Origin rejected with 403', r8.status === 403);

// 9. oversized body rejected with 413 (router spawned with KIMI_MAX_BODY_BYTES=64)
const r9 = await post({ padding: 'x'.repeat(256) });
check('oversized body rejected with 413', r9.status === 413);

// 10. non-loopback bind is refused without the explicit override
const refused = spawn(
  process.execPath,
  [routerPath],
  {
    env: {
      ...process.env,
      PORT: '9930',
      HOST: '0.0.0.0',
      KIMI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      KIMI_API_KEYS: 'test-key-1',
     KIMI_ROUTER_STATE: STATE,
      KIMI_LOG_FILE: '/tmp/kimi-router-test-refused.jsonl',
      KIMI_LOG_STDOUT: '0',
    KIMI_MANAGEMENT_TOKEN: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  }
);
let refuseOutput = '';
refused.stderr.on('data', (d) => {
  refuseOutput += d;
});
const refuseExit = await new Promise((resolve) => refused.on('exit', resolve));
check('non-loopback bind refused', refuseExit === 1 && /Refusing to bind/.test(refuseOutput));

// 11. multi-chunk SSE passes through intact
const r11 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/sse-ok`);
const sseText = await r11.text();
check('multi-chunk SSE passes through intact', sseText.includes('data: one') && sseText.includes('data: two'));

// 12. retry-after in seconds is honored and surfaced
const r12 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/retry-after-seconds`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
check('retry-after pool exhaustion returns 429', r12.status === 429);
const raSeconds = Number(r12.headers.get('retry-after'));
check('client retry-after tracks upstream retry-after', raSeconds > 3000 && raSeconds <= 3600);
const st12 = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check('cooldown reason cites retry-after seconds', st12.keys.every((k) => /retry-after 3600s/.test(k.cooldownReason)));
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });

// 13. retry-after as HTTP-date is honored
const r13 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/retry-after-date`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
check('HTTP-date pool exhaustion returns 429', r13.status === 429);
const st13 = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check('cooldown reason cites retry-after date', st13.keys.every((k) => /retry-after until/.test(k.cooldownReason)));
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });

// 14. router survives upstream dying mid-stream
try {
  await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/sse-abort`)).text();
} catch {
  // client-visible stream error is expected; a dead router is not
}
await sleep(400);
const r14 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`);
check('router alive after upstream mid-stream abort', r14.status === 200 && !routerExited);

// 15. router survives the client disconnecting mid-stream
const ac15 = new AbortController();
try {
  const resp15 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/sse-slow`, { signal: ac15.signal });
  const reader = resp15.body.getReader();
  await reader.read(); // first chunk arrived
  ac15.abort();
  await reader.cancel().catch(() => {});
} catch {
  // abort surfaces as a fetch error on the client — fine
}
await sleep(400);
const r15 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`);
check('router alive after client disconnect mid-stream', r15.status === 200 && !routerExited);
const st15 = await r15.json();
check('client disconnect releases its in-flight key slot', st15.summary.inFlight === 0);

// 16. Strict quota timers and ordinary cooldowns survive a router restart.
await fetch(`http://127.0.0.1:${ROUTER_PORT}/reset`, { method: 'POST' });
await fetch(`http://127.0.0.1:${ROUTER_PORT}/prefer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'primary@example.com', ttlMs: 60_000 }),
});
await post({ hello: 'persist-five-hour' });
await post({ msg: 'weekly-trigger' });
router.kill('SIGTERM');
await new Promise((resolve) => router.on('exit', resolve));
const persistedBeforeRestart = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const ordinaryQuotaState = Object.values(persistedBeforeRestart).find((entry) =>
  entry !== null && typeof entry === 'object' && /weekly/.test(entry.cooldownReason ?? '')
);
if (ordinaryQuotaState !== undefined) {
  ordinaryQuotaState.nextRecoveryProbeAt = Date.now() + 60_000;
  ordinaryQuotaState.recoveryProbeBackoffMs = 60_000;
}
fs.writeFileSync(STATE, JSON.stringify(persistedBeforeRestart), { mode: 0o600 });
const router2 = spawn(process.execPath, [routerPath], {
  env: {
    ...process.env,
    PORT: String(ROUTER_PORT),
    KIMI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    KIMI_API_KEYS: '',
    KIMI_KEYS_FILE: KEYS,
   KIMI_ROUTER_STATE: STATE,
    KIMI_LOG_FILE: '/tmp/kimi-router-test.jsonl',
    KIMI_LOG_STDOUT: '0',
    KIMI_MANAGEMENT_TOKEN: '',
    KIMI_MAX_BODY_BYTES: '64',
    KIMI_EXPLORATION_INTERVAL_MS: '3600000',
    KIMI_PREFERENCE_TTL_MS: '60000',
    KIMI_COOLDOWN_5H_MS: '400',
    KIMI_RECOVERY_PROBE_INITIAL_MS: '100',
    KIMI_RECOVERY_PROBE_MAX_MS: '800',
  },
  stdio: 'inherit',
});
let router2Up = false;
for (let i = 0; i < 30; i++) {
  try {
    const health = await fetch(`http://127.0.0.1:${ROUTER_PORT}/healthz`);
    if (health.status === 200) {
      router2Up = true;
      break;
    }
  } catch {
    // not up yet
  }
  await sleep(100);
}
check('router restarted', router2Up);
const st16 = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json();
check(
  'strict quota timer persists across restart',
  !st16.keys[0].available && st16.keys[0].recoveryRequired &&
    st16.keys[0].nextRecoveryProbeAt === st16.keys[0].cooldownUntil &&
    /5-hour/.test(st16.keys[0].cooldownReason) &&
    !st16.keys[1].available && /weekly/.test(st16.keys[1].cooldownReason) &&
    st16.keys[1].recoveryProbeBackoffMs === 800 &&
    st16.keys[1].nextRecoveryInMs > 0 &&
    st16.keys[1].nextRecoveryInMs <= 800
);
router2.kill('SIGTERM');
await new Promise((resolve) => router2.on('exit', resolve));

// 17. adaptive-health-v1 could persist a successful lastStatus while leaving
// an earlier cooldownUntil in place. Startup treats the later success as
// authoritative and repairs that contradiction without resetting other keys.
const staleState = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const firstStateKey = Object.keys(staleState).find((key) => key !== '__router');
staleState[firstStateKey].cooldownUntil = Date.now() + 3_600_000;
staleState[firstStateKey].cooldownReason = '';
staleState[firstStateKey].lastFailureAt = Date.now() - 2_000;
staleState[firstStateKey].lastSuccessAt = Date.now() - 1_000;
staleState[firstStateKey].lastStatus = 200;
fs.writeFileSync(STATE, JSON.stringify(staleState), { mode: 0o600 });
const router3 = spawn(process.execPath, [routerPath], {
  env: {
    ...process.env,
    PORT: String(ROUTER_PORT),
    KIMI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    KIMI_API_KEYS: '',
    KIMI_KEYS_FILE: KEYS,
   KIMI_ROUTER_STATE: STATE,
    KIMI_LOG_FILE: '/tmp/kimi-router-test.jsonl',
    KIMI_LOG_STDOUT: '0',
    KIMI_MANAGEMENT_TOKEN: '',
    KIMI_COOLDOWN_5H_MS: '400',
    KIMI_RECOVERY_PROBE_INITIAL_MS: '100',
    KIMI_RECOVERY_PROBE_MAX_MS: '800',
  },
  stdio: 'inherit',
});
let router3Up = false;
for (let i = 0; i < 30; i++) {
  try {
    const health = await fetch(`http://127.0.0.1:${ROUTER_PORT}/healthz`);
    if (health.status === 200) {
      router3Up = true;
      break;
    }
  } catch {
    // not up yet
  }
  await sleep(100);
}
const st17 = router3Up
  ? await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/status`)).json()
  : null;
check(
  'persisted success repairs only its own stale cooldown',
  router3Up && st17.keys[0].available && !st17.keys[1].available
);
router3.kill('SIGTERM');
await new Promise((resolve) => router3.on('exit', resolve));

mock.close();
fs.rmSync(KEYS, { force: true });
fs.rmSync(STATE, { force: true });

if (failures === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log(`${failures} TEST(S) FAILED`);
  process.exit(1);
}
