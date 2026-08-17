/**
 * Kimi Code weekly quota is a 7-day cycle whose phase is per membership.
 * The console clock is an epoch (one landing). Later landings are that
 * instant plus N * 7 days. A stored date in the past is not "expired
 * forever" and is not "now + 7 days from the 403".
 */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * First reset strictly after `nowMs`, walking forward 7 days from `epochMs`.
 * Returns null when the epoch is missing or not a finite timestamp.
 */
export function nextWeeklyResetAt(epochMs, nowMs) {
  if (typeof epochMs !== 'number' || Number.isFinite(epochMs) === false) {
    return null;
  }
  if (typeof nowMs !== 'number' || Number.isFinite(nowMs) === false) {
    return null;
  }
  if (epochMs > nowMs) {
    return epochMs;
  }
  const elapsed = nowMs - epochMs;
  const weeksElapsed = Math.floor(elapsed / WEEK_MS);
  return epochMs + (weeksElapsed + 1) * WEEK_MS;
}

export function parseWeeklyResetAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (Number.isFinite(value) === false || value <= 0) return null;
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== 'string') {
    throw new Error('weeklyResetAt must be an ISO timestamp or unix epoch');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber < 1_000_000_000_000 ? Math.round(asNumber * 1000) : Math.round(asNumber);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed) === false) {
    throw new Error(`invalid weeklyResetAt: ${trimmed.slice(0, 80)}`);
  }
  return parsed;
}
