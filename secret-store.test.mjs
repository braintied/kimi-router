#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createSecretStore } from './secret-store.mjs';

let calls = [];
const mac = createSecretStore({
  platform: 'darwin',
  service: 'test.service',
  spawnSync(command, args) {
    calls.push({ command, args });
    return { status: 0, stdout: 'test-secret\n', stderr: '' };
  },
});
assert.equal(mac.read('account-one'), 'test-secret');
assert.deepEqual(calls[0], {
  command: '/usr/bin/security',
  args: ['find-generic-password', '-s', 'test.service', '-a', 'account-one', '-w'],
});
assert.equal(mac.source, 'keychain');

calls = [];
const linux = createSecretStore({
  platform: 'linux',
  service: 'test.service',
  existsSync(candidate) { return candidate === '/usr/bin/secret-tool'; },
  spawnSync(command, args) {
    calls.push({ command, args });
    return { status: 0, stdout: 'linux-secret\n', stderr: '' };
  },
});
assert.equal(linux.read('account-two'), 'linux-secret');
assert.deepEqual(calls[0], {
  command: '/usr/bin/secret-tool',
  args: ['lookup', 'service', 'test.service', 'account', 'account-two'],
});
assert.equal(linux.source, 'secret-service');

assert.throws(
  () => createSecretStore({ platform: 'win32', service: 'test.service' }),
  /no supported OS secret-store backend/
);
assert.throws(() => mac.read('bad\nlabel'), /control characters/);

const failed = createSecretStore({
  platform: 'darwin',
  service: 'test.service',
  spawnSync() {
    return { status: 1, stdout: 'must-not-appear', stderr: 'must-not-appear' };
  },
});
let failureMessage = '';
try { failed.read('account-three'); } catch (error) { failureMessage = error.message; }
assert.match(failureMessage, /no readable credential/);
assert.doesNotMatch(failureMessage, /must-not-appear/);

console.log('ALL SECRET-STORE TESTS PASSED');
