import {
  DEFAULT_HARDENING_CACHE_BOUNDS,
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import { reportSecurePathHardening } from './secure-path-hardening-report'

type HardeningFailureRecord = { at: number; attempts: number }

/**
 * How often a path whose hardening keeps failing may be retried.
 *
 * Why throttle at all: the env store re-hardens on the *read* path at ~2/s (#4901), so retrying
 * every failure is an icacls-and-log storm on hosts where hardening cannot work — FAT32/exFAT have
 * no ACLs, and network paths, redirected profiles and restricted tokens refuse.
 *
 * Why exponential and not a cap: a cap that never expires latches a *transient* failure — one AV
 * scan or momentary lock and the path is abandoned for the life of the process, which can be days.
 * Backoff bounds the rate without ever bounding the lifetime. It settles at ~2 attempts/hour on a
 * permanently incapable host, which matters because the budget is per path and there are several
 * secure files; a fixed one-minute floor would leave a standing five-figure daily spawn count for
 * work that will never succeed.
 *
 * Why slowing it down is close to free: the synchronous write path is deliberately *not*
 * throttled, so a host that recovers hardens on its very next credential write. This read-path
 * re-probe is a backstop, not the recovery mechanism.
 */
const HARDENING_RETRY_FLOOR_MS = 60_000
const HARDENING_RETRY_CEILING_MS = 30 * 60_000

/**
 * Why not `Date.now`: an NTP correction, a VM snapshot restore or a user changing the clock steps
 * the wall clock backwards, which made the elapsed time negative and held every path below its
 * delay until the clock caught up — a year, for a year-long step. That is the permanent latch this
 * backoff exists to remove. Elapsed monotonic time cannot go backwards.
 */
const monotonicNowMs = (): number => performance.now()

/** Consecutive failures before the degraded state is announced. */
const HARDENING_THROTTLE_ANNOUNCE_AFTER = 3

/** Exported so the tests pin the real curve rather than a copy of it. */
export function hardeningRetryDelayMs(attempts: number): number {
  return Math.min(HARDENING_RETRY_FLOOR_MS * 2 ** (attempts - 1), HARDENING_RETRY_CEILING_MS)
}

let hardeningFailures: SecurePathHardeningCache<HardeningFailureRecord> | null = null

/**
 * Why it defaults instead of throwing: this used to require `configureHardeningRetryBudget` first,
 * and the only thing keeping that contract was import order — one module configured it at module
 * scope and happened to be the sole importer. Any second importer got a throw, and from the async
 * lane that throw lands in a `.then` handler as an unhandled rejection, which takes the Electron
 * main process down. A retry budget is not worth a crash, and a default is not worth a caller.
 */
function failures(): SecurePathHardeningCache<HardeningFailureRecord> {
  hardeningFailures ??= new SecurePathHardeningCache<HardeningFailureRecord>(
    DEFAULT_HARDENING_CACHE_BOUNDS
  )
  return hardeningFailures
}

/** Overrides the default bounds. Optional: nothing has to call this before the budget is used. */
export function configureHardeningRetryBudget(bounds: SecurePathHardeningCacheBounds): void {
  hardeningFailures = new SecurePathHardeningCache<HardeningFailureRecord>(bounds)
}

export function mayAttemptHardening(targetPath: string): boolean {
  const failure = failures().get(targetPath)
  if (!failure) {
    return true
  }
  // No cap: once the backoff elapses the path is re-probed, however long it has been failing.
  return monotonicNowMs() - failure.at >= hardeningRetryDelayMs(failure.attempts)
}

export function recordHardeningOutcome(targetPath: string, restricted: boolean): void {
  const previous = failures().get(targetPath)
  if (restricted) {
    failures().delete(targetPath)
    if (previous && previous.attempts >= HARDENING_THROTTLE_ANNOUNCE_AFTER) {
      reportSecurePathHardening(
        targetPath,
        'recovered',
        `hardening succeeded again after ${previous.attempts} consecutive failures`
      )
    }
    return
  }
  const attempts = (previous?.attempts ?? 0) + 1
  failures().set(targetPath, { at: monotonicNowMs(), attempts })
  // Fires exactly once: attempts only rises, and a success clears the record entirely.
  if (attempts === HARDENING_THROTTLE_ANNOUNCE_AFTER) {
    reportSecurePathHardening(
      targetPath,
      'throttled',
      `hardening failed ${attempts} times; backing off toward one retry per ${HARDENING_RETRY_CEILING_MS / 60_000} minutes until it succeeds`
    )
  }
}
