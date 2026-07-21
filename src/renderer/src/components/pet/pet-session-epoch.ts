// When to rotate the pet's omp session so context stays fresh.
//
// buildPetOmpAgentArgs normally passes --continue, which resumes the most
// recent session in the per-worktree dir. Left forever that thread only grows,
// and stale context starts to weigh on a small local model. Operator decision:
// roll to a fresh session every 1–3 hours.
//
// The threshold is randomised within that band per epoch rather than a fixed 2h,
// so rotations do not all land on a predictable boundary — "every 1–3 hours"
// literally. Persisted per session-dir key so the clock survives an app restart;
// a restart mid-window resumes the same thread, it does not reset the timer.

const STORAGE_PREFIX = 'orca.pet.sessionEpoch.v1:'
const HOUR_MS = 60 * 60 * 1000
export const ROTATE_MIN_MS = 1 * HOUR_MS
export const ROTATE_MAX_MS = 3 * HOUR_MS

export type SessionEpoch = {
  startedAt: number
  /** The rotation deadline for THIS epoch, drawn once in [MIN, MAX]. Stored so a
   *  restart cannot re-roll it into a shorter or longer window. */
  thresholdMs: number
}

function rollThreshold(random: () => number = Math.random): number {
  return Math.round(ROTATE_MIN_MS + random() * (ROTATE_MAX_MS - ROTATE_MIN_MS))
}

function readEpoch(key: string): SessionEpoch | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<SessionEpoch> | null
    if (typeof parsed?.startedAt !== 'number' || typeof parsed.thresholdMs !== 'number') {
      return null
    }
    return { startedAt: parsed.startedAt, thresholdMs: parsed.thresholdMs }
  } catch {
    return null
  }
}

function writeEpoch(key: string, epoch: SessionEpoch): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + key, JSON.stringify(epoch))
  } catch {
    // Non-fatal: without persistence the pet still rotates, just not across
    // restarts.
  }
}

/**
 * Pure rotation decision. Returns whether this spawn should start FRESH (omit
 * --continue) and the epoch to persist afterwards. A fresh spawn is chosen when
 * there is no epoch yet — wait, no: the FIRST spawn should continue any existing
 * on-disk thread, so a missing epoch is treated as "start the clock, continue".
 * Only an epoch older than its own threshold rotates.
 */
export function decideSessionFreshness(
  epoch: SessionEpoch | null,
  now: number,
  random: () => number = Math.random
): { fresh: boolean; nextEpoch: SessionEpoch } {
  if (!epoch) {
    // No clock yet: keep whatever is on disk (--continue) and start timing from
    // now. Rotating here would throw away a thread the operator may have been
    // mid-conversation in before this build started tracking epochs.
    return { fresh: false, nextEpoch: { startedAt: now, thresholdMs: rollThreshold(random) } }
  }
  if (now - epoch.startedAt >= epoch.thresholdMs) {
    return { fresh: true, nextEpoch: { startedAt: now, thresholdMs: rollThreshold(random) } }
  }
  return { fresh: false, nextEpoch: epoch }
}

/**
 * Resolve freshness for a session-dir key against the persisted epoch, and
 * persist the advanced epoch. The single side-effecting entry point the spawn
 * calls; the decision itself is `decideSessionFreshness`, kept pure for tests.
 */
export function resolveSpawnFreshness(key: string, now: number = Date.now()): boolean {
  const { fresh, nextEpoch } = decideSessionFreshness(readEpoch(key), now)
  writeEpoch(key, nextEpoch)
  return fresh
}
