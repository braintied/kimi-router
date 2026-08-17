#!/usr/bin/env node
/**
 * 2026 weekly-reset landings for the four membership clocks recorded
 * 2026-07-31 from the Kimi Code Console.
 */

import assert from 'node:assert/strict';

import { WEEK_MS, nextWeeklyResetAt, parseWeeklyResetAt } from './src/weekly-reset.mjs';

const AUG_17_2026_PT_1025 = Date.parse('2026-08-17T17:25:11.000Z');

const CLOCKS = [
  {
    label: 'hello@braintied.com',
    epoch: '2026-08-01T00:39:32.000Z',
    landings: [
      '2026-08-01T00:39:32.000Z',
      '2026-08-08T00:39:32.000Z',
      '2026-08-15T00:39:32.000Z',
      '2026-08-22T00:39:32.000Z',
    ],
    nextOnAug17: '2026-08-22T00:39:32.000Z',
  },
  {
    label: 'g@braintied.com',
    epoch: '2026-08-01T23:26:23.000Z',
    landings: [
      '2026-08-01T23:26:23.000Z',
      '2026-08-08T23:26:23.000Z',
      '2026-08-15T23:26:23.000Z',
      '2026-08-22T23:26:23.000Z',
    ],
    nextOnAug17: '2026-08-22T23:26:23.000Z',
  },
  {
    label: 'galenoakes@gmail.com',
    epoch: '2026-08-02T02:10:14.000Z',
    landings: [
      '2026-08-02T02:10:14.000Z',
      '2026-08-09T02:10:14.000Z',
      '2026-08-16T02:10:14.000Z',
      '2026-08-23T02:10:14.000Z',
    ],
    nextOnAug17: '2026-08-23T02:10:14.000Z',
  },
  {
    label: 'nex@braintied.com',
    epoch: '2026-08-02T06:17:00.000Z',
    landings: [
      '2026-08-02T06:17:00.000Z',
      '2026-08-09T06:17:00.000Z',
      '2026-08-16T06:17:00.000Z',
      '2026-08-23T06:17:00.000Z',
    ],
    nextOnAug17: '2026-08-23T06:17:00.000Z',
  },
];

assert.equal(WEEK_MS, 7 * 24 * 60 * 60 * 1000);

for (const clock of CLOCKS) {
  const epochMs = parseWeeklyResetAt(clock.epoch);
  assert.equal(new Date(epochMs).toISOString(), clock.epoch, clock.label);
  for (let i = 1; i < clock.landings.length; i += 1) {
    const prev = Date.parse(clock.landings[i - 1]);
    const landing = Date.parse(clock.landings[i]);
    assert.equal(landing - prev, WEEK_MS, `${clock.label} landing ${i}`);
  }
  const next = nextWeeklyResetAt(epochMs, AUG_17_2026_PT_1025);
  assert.equal(
    new Date(next).toISOString(),
    clock.nextOnAug17,
    `${clock.label} next after 2026-08-17 is not now+7d and is not the Aug 1 epoch`
  );
  assert.ok(next > AUG_17_2026_PT_1025, `${clock.label} next must be strictly after now`);
  assert.ok(
    next - AUG_17_2026_PT_1025 < WEEK_MS,
    `${clock.label} next must be inside the current 7-day window, not skipped weeks`
  );
}

// Aug 1 + 7 is Aug 8, not Aug 22. The function must still name Aug 8 when
// asked on Aug 2.
const gEpoch = parseWeeklyResetAt('2026-08-01T23:26:23.000Z');
assert.equal(
  new Date(nextWeeklyResetAt(gEpoch, Date.parse('2026-08-02T00:00:00.000Z'))).toISOString(),
  '2026-08-08T23:26:23.000Z'
);

// A past epoch is not discarded. A future epoch is used as-is.
assert.equal(nextWeeklyResetAt(null, AUG_17_2026_PT_1025), null);
const future = Date.parse('2026-09-01T00:00:00.000Z');
assert.equal(nextWeeklyResetAt(future, AUG_17_2026_PT_1025), future);

// Exactly on a landing, the next landing is +7d (quota is available at the
// landing itself).
assert.equal(
  nextWeeklyResetAt(Date.parse('2026-08-15T23:26:23.000Z'), Date.parse('2026-08-15T23:26:23.000Z')),
  Date.parse('2026-08-22T23:26:23.000Z')
);

console.log('ALL WEEKLY-RESET TESTS PASSED');
