#!/usr/bin/env node
/**
 * Snapshot this package onto braintied/kimi-router (public README + Releases).
 *
 *   node packages/kimi-router/scripts/sync-public.mjs
 *   node packages/kimi-router/scripts/sync-public.mjs --apply
 *   node packages/kimi-router/scripts/sync-public.mjs --apply --push
 *
 * Dest: --dest PATH, else $KIMI_ROUTER_PUBLIC_DIR, else ~/Development/kimi-router.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const APPLY = process.argv.includes('--apply');
const PUSH = process.argv.includes('--push');

const FORBIDDEN = [
  /sk-[A-Za-z0-9]{16,}/,
  /KIMI_MEMBERSHIP_KEY_[0-9]+=\S+/,
  /ghp_[A-Za-z0-9]{20,}/,
];

const ROOT_FILES = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'keychain-write.swift',
  'keychain-relabel.swift',
];

const ROOT_TESTS = [
  'config.test.mjs',
  'weekly-reset.test.mjs',
  'provider-adapters.test.mjs',
  'secret-store.test.mjs',
  'relabel-accounts.test.mjs',
  'router.test.mjs',
  'router.v3.test.mjs',
  'state-lifecycle.test.mjs',
  'launcher.test.mjs',
];

function destDir(argv = process.argv, env = process.env) {
  const flag = argv.indexOf('--dest');
  if (flag >= 0 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  if (env.KIMI_ROUTER_PUBLIC_DIR) return path.resolve(env.KIMI_ROUTER_PUBLIC_DIR);
  return path.join(homedir(), 'Development', 'kimi-router');
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'releases' || name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function assertPublicRepo(dest) {
  let url = '';
  try {
    url = execFileSync('git', ['-C', dest, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    throw new Error(`${dest} is not a git checkout`);
  }
  if (!/github\.com[:/]braintied\/kimi-router(?:\.git)?$/.test(url)) {
    throw new Error(`refusing to write: origin is ${url}, want braintied/kimi-router`);
  }
}

function copyTree(relDir, dest, written) {
  const fromDir = path.join(PKG, relDir);
  if (!existsSync(fromDir)) throw new Error(`missing ${relDir}`);
  for (const file of walk(fromDir)) {
    const rel = path.join(relDir, path.relative(fromDir, file)).split(path.sep).join('/');
    const body = readFileSync(file);
    const text = body.toString('utf8');
    const hits = FORBIDDEN.filter((n) => n.test(text)).map((n) => String(n));
    if (hits.length > 0) throw new Error(`${rel} contains forbidden tokens: ${hits.join(', ')}`);
    if (APPLY) {
      const to = path.join(dest, rel);
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, body);
    }
    written.push(rel);
  }
}

function main() {
  const dest = destDir();
  if (!existsSync(dest)) {
    throw new Error(`clone braintied/kimi-router to ${dest} first`);
  }
  assertPublicRepo(dest);
  const version = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  const written = [];

  for (const rel of [...ROOT_FILES, ...ROOT_TESTS]) {
    const from = path.join(PKG, rel);
    if (!existsSync(from)) {
      if (rel === 'LICENSE') continue;
      throw new Error(`missing ${rel}`);
    }
    const body = readFileSync(from);
    const text = body.toString('utf8');
    const hits = FORBIDDEN.filter((n) => n.test(text)).map((n) => String(n));
    if (hits.length > 0) throw new Error(`${rel} contains forbidden tokens: ${hits.join(', ')}`);
    if (APPLY) writeFileSync(path.join(dest, rel), body);
    written.push(rel);
  }
  copyTree('bin', dest, written);
  copyTree('src', dest, written);
  copyTree('docs', dest, written);
  copyTree('scripts', dest, written);

  // Public repo used a flat 0.1.x layout. Remove leftover root modules so
  // install.mjs --activate is the only entry.
  const stale = [
    'router.mjs',
    'install.mjs',
    'kimi',
    'migrate-keychain.mjs',
    'relabel-accounts.mjs',
    'provider-adapters.mjs',
    'secret-store.mjs',
  ];
  if (APPLY) {
    for (const name of stale) {
      const p = path.join(dest, name);
      if (existsSync(p)) rmSync(p);
    }
  }

  console.log(`${APPLY ? 'wrote' : 'would write'} ${written.length} files → ${dest} (@${version})`);
  written.slice(0, 12).forEach((r) => console.log(`  ${r}`));
  if (written.length > 12) console.log(`  … +${written.length - 12}`);

  if (APPLY && PUSH) {
    execFileSync('git', ['-C', dest, 'add', '-A'], { stdio: 'inherit' });
    const dirty = execFileSync('git', ['-C', dest, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    if (dirty === '') {
      console.log('public repo already matches');
      return;
    }
    execFileSync(
      'git',
      ['-C', dest, 'commit', '-m', `sync @braintied/kimi-router ${version} from stack`],
      { stdio: 'inherit' },
    );
    execFileSync('git', ['-C', dest, 'push', 'origin', 'HEAD'], { stdio: 'inherit' });
  }
}

main();
