import fs from 'node:fs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

function normalizeLabel(value) {
  if (typeof value !== 'string') throw new TypeError('secret label must be a string');
  const label = value.trim();
  if (label === '' || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('secret label is empty or contains control characters');
  }
  return label;
}

function readResult(result, backend, label) {
  if (result?.status !== 0) {
    throw new Error(`${backend} has no readable credential for ${label}`);
  }
  const secret = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (secret === '') throw new Error(`${backend} returned an empty credential for ${label}`);
  return secret;
}

function findExecutable(candidates, existsSync) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function createSecretStore({
  backend = 'auto',
  platform = process.platform,
  service,
  spawnSync = nodeSpawnSync,
  existsSync = fs.existsSync,
} = {}) {
  if (typeof service !== 'string' || service.trim() === '') {
    throw new Error('secret-store service name is required');
  }
  const selected = backend === 'auto'
    ? platform === 'darwin'
      ? 'macos-keychain'
      : platform === 'linux'
        ? 'linux-secret-service'
        : 'unsupported'
    : backend;

  if (selected === 'macos-keychain') {
    if (platform !== 'darwin') throw new Error('macOS Keychain backend requires macOS');
    return {
      name: selected,
      source: 'keychain',
      read(labelValue) {
        const label = normalizeLabel(labelValue);
        const result = spawnSync(
          '/usr/bin/security',
          ['find-generic-password', '-s', service, '-a', label, '-w'],
          { encoding: 'utf8', maxBuffer: 1024 * 1024 }
        );
        return readResult(result, 'macOS Keychain', label);
      },
    };
  }

  if (selected === 'linux-secret-service') {
    if (platform !== 'linux') throw new Error('Linux Secret Service backend requires Linux');
    const executable = findExecutable(
      ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool'],
      existsSync
    );
    if (executable === null) {
      throw new Error('Linux Secret Service requires secret-tool (libsecret)');
    }
    return {
      name: selected,
      source: 'secret-service',
      read(labelValue) {
        const label = normalizeLabel(labelValue);
        const result = spawnSync(
          executable,
          ['lookup', 'service', service, 'account', label],
          { encoding: 'utf8', maxBuffer: 1024 * 1024 }
        );
        return readResult(result, 'Linux Secret Service', label);
      },
    };
  }

  throw new Error(
    `no supported OS secret-store backend for ${platform}; ` +
    'use macOS Keychain or Linux Secret Service'
  );
}
