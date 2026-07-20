#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-router-state-test-'));
const stateFile = path.join(tempDir, 'state.json');
const keyFile = path.join(tempDir, 'keys');
const clockFile = path.join(tempDir, 'clock');
const logFile = path.join(tempDir, 'router.jsonl');
const routerPath = new URL('./router.mjs', import.meta.url).pathname;
const routerPort = 9930;
const secondPort = 9932;
const upstreamPort = 9931;
const base = `http://127.0.0.1:${routerPort}`;
const startTime = Date.UTC(2026, 6, 19, 12, 0, 0);

fs.writeFileSync(stateFile, '{broken-json', { mode: 0o600 });
fs.writeFileSync(keyFile, '# primary\ntest-primary\n# backup\ntest-backup\n', { mode: 0o600 });
fs.writeFileSync(clockFile, String(startTime), { mode: 0o600 });

let primaryRecovered = false;
const seen = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(key);
    if (key === 'test-primary' && !primaryRecovered) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          type: 'rate_limit_error',
          code: 'usage_limit',
          message: "You've reached your usage limit for this period. Your quota will be refreshed in the next period.",
        },
        ignored: 'engine overloaded',
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, used: key, bodyLength: body.length }));
  });
});

await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

function routerEnv(port) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    KIMI_PROVIDER_PROFILE: 'custom',
    KIMI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    KIMI_API_KEYS: '',
    KIMI_KEYS_FILE: keyFile,
    KIMI_ROUTER_STATE: stateFile,
    KIMI_TEST_CLOCK_FILE: clockFile,
    KIMI_LOG_FILE: logFile,
    KIMI_LOG_STDOUT: '0',
    KIMI_MANAGEMENT_TOKEN: '',
    KIMI_EXPLORATION_INTERVAL_MS: '3600000',
    KIMI_RECOVERY_PROBE_INITIAL_MS: '30000',
    KIMI_DRAIN_TIMEOUT_MS: '2000',
  };
}

function launch(port = routerPort) {
  const child = spawn(process.execPath, [routerPath], {
    env: routerEnv(port),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderrText = '';
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url = base, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/healthz`)).status === 200) return;
    } catch { /* starting */ }
    await sleep(40);
  }
  throw new Error(`router did not become healthy at ${url}`);
}

async function waitForExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs).then(() => { throw new Error('process did not exit'); }),
  ]);
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null) return;
  child.kill(signal);
  await waitForExit(child);
}

async function post() {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'k3', messages: [{ role: 'user', content: 'test' }] }),
  });
}

let router = launch();
try {
  await waitForHealth();
  const quarantined = fs.readdirSync(tempDir).filter((name) => name.startsWith('state.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'corrupt state should be quarantined exactly once');

  const first = await post();
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.used, 'test-backup');
  assert.deepEqual(seen.slice(-2), ['test-primary', 'test-backup']);

  const statusAfterQuota = await (await fetch(`${base}/status`)).json();
  const primary = statusAfterQuota.keys.find((key) => key.label === 'primary');
  assert.equal(primary.available, false);
  assert.deepEqual(primary.quotaWindow, {
    kind: 'five-hour',
    resetAt: new Date(startTime + 5 * 60 * 60 * 1000).toISOString(),
    source: 'policy',
  });
  assert.equal(statusAfterQuota.summary.available, 1);
  assert.equal(statusAfterQuota.provider.id, 'custom');

  const hitsBefore = seen.length;
  const second = await post();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).used, 'test-backup');
  assert.deepEqual(seen.slice(hitsBefore), ['test-backup'], 'exhausted account must not remain selected');

  const competing = launch(secondPort);
  const competingExit = await waitForExit(competing);
  assert.equal(competingExit, 1);
  assert.match(competing.stderrText, /state is already owned by router process/);
  assert.doesNotMatch(competing.stderrText, /test-primary|test-backup/);

  primaryRecovered = true;
  fs.writeFileSync(clockFile, String(startTime + 5 * 60 * 60 * 1000), { mode: 0o600 });
  const recovered = await post();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).used, 'test-primary');
  const recoveredStatus = await (await fetch(`${base}/status`)).json();
  const recoveredPrimary = recoveredStatus.keys.find((key) => key.label === 'primary');
  assert.equal(recoveredPrimary.available, true);
  assert.equal(recoveredPrimary.quotaWindow, null);

  router.kill('SIGKILL');
  await waitForExit(router);
  router = launch();
  await waitForHealth();
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'stale lock should recover after a crash');
  assert.equal((await post()).status, 200, 'recovered writer should persist fresh state');

  await stop(router);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.__meta.schemaVersion, 2);
  assert.equal(typeof persisted.__meta.writtenAt, 'string');
  assert.equal(fs.existsSync(`${stateFile}.lock`), false, 'normal shutdown should release the lock');
  console.log('state lifecycle tests passed');
} finally {
  await stop(router).catch(() => {});
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
