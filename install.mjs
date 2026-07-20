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
const managementHeaderFile = path.join(configDir, 'management.header');
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, 'ai.ora.kimi-key-router.plist');
const installedRouter = path.join(installDir, 'router.mjs');
const installedLauncher = path.join(binDir, 'kimi');
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

for (const required of ['router.mjs', 'kimi']) {
  if (!fs.existsSync(path.join(sourceDir, required))) fail(`Missing source file: ${required}`);
}
const syntax = run(nodeExecutable, ['--check', path.join(sourceDir, 'router.mjs')]);
if (syntax.status !== 0) fail(`Router syntax check failed: ${syntax.stderr}`);
if (!fs.existsSync(accountsFile)) {
  fail(`Missing ${accountsFile}. Run migrate-keychain.mjs before installing.`);
}

for (const directory of [installDir, binDir, stateDir, configDir, launchAgentsDir]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
fs.copyFileSync(path.join(sourceDir, 'router.mjs'), installedRouter);
fs.chmodSync(installedRouter, 0o755);
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
  fail(`Generated launchd plist is invalid: ${lint.stderr || lint.stdout}`);
}

console.log(`Installed router: ${installedRouter}`);
console.log(`Installed launcher: ${installedLauncher}`);
console.log(`Installed service definition: ${plistPath}`);
console.log(`Installed management credential: ${managementHeaderFile}`);

if (!activate) {
  console.log('Service was not restarted. Run install.mjs --activate after parallel validation.');
  process.exit(0);
}

run('/bin/launchctl', ['bootout', domain, plistPath]);
const bootstrap = run('/bin/launchctl', ['bootstrap', domain, plistPath]);
if (bootstrap.status !== 0) {
  console.error(`New service failed to load: ${(bootstrap.stderr || bootstrap.stdout).trim()}`);
  if (previousPlist !== null) {
    fs.writeFileSync(plistPath, previousPlist, { mode: 0o600 });
    const rollback = run('/bin/launchctl', ['bootstrap', domain, plistPath]);
    if (rollback.status === 0) console.error('Previous service definition was restored and loaded.');
    else console.error(`Rollback also failed: ${(rollback.stderr || rollback.stdout).trim()}`);
  }
  process.exit(1);
}
const printed = run('/bin/launchctl', ['print', service]);
if (printed.status !== 0) fail(`Service loaded but launchctl cannot inspect ${service}.`);
console.log('Activated ai.ora.kimi-key-router.');
