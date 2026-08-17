#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

process.umask(0o077);

const activate = process.argv.includes('--activate');
// The package root, one level above bin/: the installer copies both bin/ and
// src/ because the daemon entry imports its library half by relative path.
const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const installDir = path.join(home, '.local', 'share', 'kimi-router');
const binDir = path.join(home, '.local', 'bin');
const stateDir = path.join(home, '.local', 'state', 'kimi-router');
const configDir = path.join(home, '.config', 'kimi-router');
const rollbackDir = path.join(installDir, 'rollback');
const managementHeaderFile = path.join(configDir, 'management.header');
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, 'ai.ora.kimi-key-router.plist');
const installedRouter = path.join(installDir, 'bin', 'kimi-router.mjs');
const installedRouterCore = path.join(installDir, 'src', 'router.mjs');
const installedConfig = path.join(installDir, 'src', 'config.mjs');
const installedProviderAdapters = path.join(installDir, 'src', 'provider-adapters.mjs');
const installedSecretStore = path.join(installDir, 'src', 'secret-store.mjs');
const installedLauncher = path.join(binDir, 'kimi');

/**
 * Every file the service needs, in copy order. A table rather than a variable
 * per file: the daemon became a bin/ entry over a src/ library, and rollback
 * has to restore exactly the set that was replaced, whatever its size.
 */
const INSTALLED_FILES = [
  { source: path.join('bin', 'kimi-router.mjs'), target: installedRouter, mode: 0o755 },
  { source: path.join('src', 'router.mjs'), target: installedRouterCore, mode: 0o644 },
  { source: path.join('src', 'config.mjs'), target: installedConfig, mode: 0o644 },
  { source: path.join('src', 'weekly-reset.mjs'), target: path.join(installDir, 'src', 'weekly-reset.mjs'), mode: 0o644 },
  { source: path.join('src', 'provider-adapters.mjs'), target: installedProviderAdapters, mode: 0o644 },
  { source: path.join('src', 'secret-store.mjs'), target: installedSecretStore, mode: 0o644 },
  { source: path.join('bin', 'kimi'), target: installedLauncher, mode: 0o755 },
];

/** Where a replaced file is parked so a failed activation can put it back. */
function rollbackPathFor(entry) {
  return path.join(rollbackDir, entry.source);
}
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

function restoreInstalledFiles(present) {
  for (const entry of INSTALLED_FILES) {
    const rollback = rollbackPathFor(entry);
    if (present.get(entry.source) === true && fs.existsSync(rollback)) {
      fs.copyFileSync(rollback, entry.target);
      fs.chmodSync(entry.target, entry.mode);
    } else if (present.get(entry.source) !== true && fs.existsSync(entry.target)) {
      fs.unlinkSync(entry.target);
    }
  }
}

for (const entry of INSTALLED_FILES) {
  if (!fs.existsSync(path.join(sourceDir, entry.source))) fail(`Missing source file: ${entry.source}`);
}
for (const entry of INSTALLED_FILES) {
  if (!entry.source.endsWith('.mjs')) continue;
  const syntax = run(nodeExecutable, ['--check', path.join(sourceDir, entry.source)]);
  if (syntax.status !== 0) fail(`Router syntax check failed for ${entry.source}: ${syntax.stderr}`);
}
if (!fs.existsSync(accountsFile)) {
  fail(`Missing ${accountsFile}. Run migrate-keychain.mjs before installing.`);
}

for (const directory of [installDir, rollbackDir, binDir, stateDir, configDir, launchAgentsDir]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const present = new Map();
for (const entry of INSTALLED_FILES) {
  present.set(entry.source, fs.existsSync(entry.target));
  const rollback = rollbackPathFor(entry);
  fs.mkdirSync(path.dirname(rollback), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
  if (present.get(entry.source) === true) fs.copyFileSync(entry.target, rollback);
}
for (const entry of INSTALLED_FILES) {
  fs.copyFileSync(path.join(sourceDir, entry.source), entry.target);
  fs.chmodSync(entry.target, entry.mode);
}

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
    <key>KIMI_PROVIDER_PROFILE</key><string>kimi-code-membership</string>
    <key>KIMI_BASE_URL</key><string>https://api.kimi.com</string>
    <key>KIMI_ACCOUNTS_FILE</key><string>${xml(accountsFile)}</string>
    <key>KIMI_ACCOUNTS_META_FILE</key><string>${xml(path.join(configDir, 'accounts.meta.json'))}</string>
    <key>KIMI_KEYCHAIN_SERVICE</key><string>ai.ora.kimi-key-router</string>
    <key>KIMI_ROUTER_STATE</key><string>${xml(stateFile)}</string>
    <key>KIMI_LOG_FILE</key><string>${xml(logFile)}</string>
    <key>KIMI_LOG_STDOUT</key><string>0</string>
    <key>KIMI_MANAGEMENT_TOKEN_FILE</key><string>${xml(managementHeaderFile)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(installDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Interactive, not Background. Background applies DARWIN_BG: per-syscall
       I/O throttling and the lowest CPU tier, inherited by children. That is
       right for an idle periodic job and wrong for an HTTP server on the hot
       path of every routed request. Caught 2026-07-24 by 'supervisor audit'
       and confirmed with 'ps': the running router sat at PRI 4, versus 31
       after the change. Fixed here as well as on the machine, because this
       installer writes the plist and would otherwise regress it on next run. -->
  <key>ProcessType</key><string>Interactive</string>
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
  restoreInstalledFiles(present);
  fail(`Generated launchd plist is invalid: ${lint.stderr || lint.stdout}`);
}

console.log(`Installed router: ${installedRouter}`);
console.log(`Installed provider adapters: ${installedProviderAdapters}`);
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
    restoreInstalledFiles(present);
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
  restoreInstalledFiles(present);
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
