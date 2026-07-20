#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

process.umask(0o077);

const activate = process.argv.includes('--activate');
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const installDir = path.join(home, '.local', 'share', 'kimi-router');
const binDir = path.join(home, '.local', 'bin');
const stateDir = path.join(home, '.local', 'state', 'kimi-router');
const configDir = path.join(home, '.config', 'kimi-router');
const rollbackDir = path.join(installDir, 'rollback');
const managementHeaderFile = path.join(configDir, 'management.header');
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, 'ai.ora.kimi-key-router.plist');
const installedRouter = path.join(installDir, 'router.mjs');
const installedSecretStore = path.join(installDir, 'secret-store.mjs');
const installedLauncher = path.join(binDir, 'kimi');
const rollbackRouter = path.join(rollbackDir, 'router.mjs');
const rollbackSecretStore = path.join(rollbackDir, 'secret-store.mjs');
const rollbackLauncher = path.join(rollbackDir, 'kimi');
const accountsFile = path.join(home, '.kimi-key-accounts');
const stateFile = path.join(home, '.kimi-key-router-state.json');
const logFile = path.join(stateDir, 'router.jsonl');
const domain = `gui/${process.getuid()}`;
const service = `${domain}/ai.ora.kimi-key-router`;
const nodeExecutable = ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath]
  .find((candidate) => fs.existsSync(candidate));

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function restoreInstalledFiles(hadRouter, hadSecretStore, hadLauncher) {
  if (hadRouter && fs.existsSync(rollbackRouter)) {
    fs.copyFileSync(rollbackRouter, installedRouter);
    fs.chmodSync(installedRouter, 0o755);
  } else if (!hadRouter && fs.existsSync(installedRouter)) {
    fs.unlinkSync(installedRouter);
  }
  if (hadSecretStore && fs.existsSync(rollbackSecretStore)) {
    fs.copyFileSync(rollbackSecretStore, installedSecretStore);
    fs.chmodSync(installedSecretStore, 0o644);
  } else if (!hadSecretStore && fs.existsSync(installedSecretStore)) {
    fs.unlinkSync(installedSecretStore);
  }
  if (hadLauncher && fs.existsSync(rollbackLauncher)) {
    fs.copyFileSync(rollbackLauncher, installedLauncher);
    fs.chmodSync(installedLauncher, 0o755);
  } else if (!hadLauncher && fs.existsSync(installedLauncher)) {
    fs.unlinkSync(installedLauncher);
  }
}

for (const required of ['router.mjs', 'secret-store.mjs', 'kimi']) {
  if (!fs.existsSync(path.join(sourceDir, required))) fail(`Missing source file: ${required}`);
}
const syntax = run(nodeExecutable, ['--check', path.join(sourceDir, 'router.mjs')]);
if (syntax.status !== 0) fail(`Router syntax check failed: ${syntax.stderr}`);
if (!fs.existsSync(accountsFile)) {
  fail(`Missing ${accountsFile}. Run migrate-keychain.mjs before installing.`);
}

for (const directory of [installDir, rollbackDir, binDir, stateDir, configDir, launchAgentsDir]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const hadRouter = fs.existsSync(installedRouter);
const hadSecretStore = fs.existsSync(installedSecretStore);
const hadLauncher = fs.existsSync(installedLauncher);
if (hadRouter) fs.copyFileSync(installedRouter, rollbackRouter);
if (hadSecretStore) fs.copyFileSync(installedSecretStore, rollbackSecretStore);
if (hadLauncher) fs.copyFileSync(installedLauncher, rollbackLauncher);
fs.copyFileSync(path.join(sourceDir, 'router.mjs'), installedRouter);
fs.chmodSync(installedRouter, 0o755);
fs.copyFileSync(path.join(sourceDir, 'secret-store.mjs'), installedSecretStore);
fs.chmodSync(installedSecretStore, 0o644);
fs.copyFileSync(path.join(sourceDir, 'kimi'), installedLauncher);
fs.chmodSync(installedLauncher, 0o755);

if (!fs.existsSync(managementHeaderFile)) {
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(managementHeaderFile, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
}
fs.chmodSync(managementHeaderFile, 0o600);
const managementHeader = fs.readFileSync(managementHeaderFile, 'utf8').trim();
if (!/^Authorization: Bearer [A-Za-z0-9_-]{32,}$/i.test(managementHeader)) {
  fail(`Invalid management credential file: ${managementHeaderFile}`);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.ora.kimi-key-router</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeExecutable)}</string>
    <string>${xml(installedRouter)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KIMI_BASE_URL</key><string>https://api.kimi.com</string>
    <key>KIMI_ACCOUNTS_FILE</key><string>${xml(accountsFile)}</string>
    <key>KIMI_KEYCHAIN_SERVICE</key><string>ai.ora.kimi-key-router</string>
    <key>KIMI_ROUTER_STATE</key><string>${xml(stateFile)}</string>
    <key>KIMI_LOG_FILE</key><string>${xml(logFile)}</string>
    <key>KIMI_LOG_STDOUT</key><string>0</string>
    <key>KIMI_MANAGEMENT_TOKEN_FILE</key><string>${xml(managementHeaderFile)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(installDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(path.join(stateDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;

const previousPlist = fs.existsSync(plistPath) ? fs.readFileSync(plistPath) : null;
const tmpPlist = `${plistPath}.tmp`;
fs.writeFileSync(tmpPlist, plist, { mode: 0o600 });
fs.renameSync(tmpPlist, plistPath);
fs.chmodSync(plistPath, 0o600);

const lint = run('/usr/bin/plutil', ['-lint', plistPath]);
if (lint.status !== 0) {
  if (previousPlist !== null) fs.writeFileSync(plistPath, previousPlist, { mode: 0o600 });
  restoreInstalledFiles(hadRouter, hadSecretStore, hadLauncher);
  fail(`Generated launchd plist is invalid: ${lint.stderr || lint.stdout}`);
}

console.log(`Installed router: ${installedRouter}`);
console.log(`Installed secret-store adapter: ${installedSecretStore}`);
console.log(`Installed launcher: ${installedLauncher}`);
console.log(`Installed service definition: ${plistPath}`);
console.log(`Installed management credential: ${managementHeaderFile}`);

if (!activate) {
  console.log('Service was not restarted. Run install.mjs --activate after parallel validation.');
  process.exit(0);
}

const current = run('/bin/launchctl', ['print', service]);
const currentPid = Number(current.stdout.match(/^[ \t]*pid = (\d+)/m)?.[1]);
if (Number.isInteger(currentPid) && currentPid > 0) {
  try { process.kill(currentPid, 'SIGTERM'); } catch { /* already stopped */ }
  const drainDeadline = Date.now() + 125_000;
  while (processAlive(currentPid) && Date.now() < drainDeadline) sleep(100);
  if (processAlive(currentPid)) {
    restoreInstalledFiles(hadRouter, hadSecretStore, hadLauncher);
    if (previousPlist !== null) fs.writeFileSync(plistPath, previousPlist, { mode: 0o600 });
    fail('Existing router did not drain before the activation deadline; previous files were restored.');
  }
}
run('/bin/launchctl', ['bootout', domain, plistPath]);
const bootstrap = run('/bin/launchctl', ['bootstrap', domain, plistPath]);
let healthy = false;
if (bootstrap.status === 0) {
  const healthDeadline = Date.now() + 30_000;
  while (Date.now() < healthDeadline) {
    const health = run('/usr/bin/curl', [
      '-fsS', '--max-time', '1', 'http://127.0.0.1:8787/healthz',
    ]);
    if (health.status === 0) { healthy = true; break; }
    sleep(100);
  }
}
if (!healthy) {
  run('/bin/launchctl', ['bootout', domain, plistPath]);
  restoreInstalledFiles(hadRouter, hadSecretStore, hadLauncher);
  if (previousPlist !== null) {
    fs.writeFileSync(plistPath, previousPlist, { mode: 0o600 });
    const rollback = run('/bin/launchctl', ['bootstrap', domain, plistPath]);
    if (rollback.status === 0) console.error('Candidate failed health checks; previous files and service were restored.');
    else console.error(`Candidate and rollback failed: ${(rollback.stderr || rollback.stdout).trim()}`);
  }
  fail(`Candidate service failed activation health checks: ${(bootstrap.stderr || bootstrap.stdout).trim()}`);
}
const printed = run('/bin/launchctl', ['print', service]);
if (printed.status !== 0) fail(`Service became healthy but launchctl cannot inspect ${service}.`);
console.log('Activated and health-verified ai.ora.kimi-key-router.');
