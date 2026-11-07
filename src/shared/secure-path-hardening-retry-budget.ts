import {
  DEFAULT_HARDENING_CACHE_BOUNDS,
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import { reportSecurePathHardening } from './secure-path-hardening-report'

type HardeningFailureRecord = { at: number; attempts: number }

/** Read-path polling (~2/s, #4901) needs exponential backoff on incapable hosts, but never permanent abandonment
 * after transient locks/AV scans. Settle at two attempts/hour/path; writes remain unthrottled for immediate recovery. */
const HARDENING_RETRY_FLOOR_MS = 60_000
const HARDENING_RETRY_CEILING_MS = 30 * 60_000

/** Wall clocks can step backward for years after NTP/VM/user changes; monotonic elapsed time prevents retry latches. */
const monotonicNowMs = (): number => performance.now()

/** Consecutive failures before the degraded state is announced. */
const HARDENING_THROTTLE_ANNOUNCE_AFTER = 3

/** Exported so the tests pin the real curve rather than a copy of it. */
export function hardeningRetryDelayMs(attempts: number): number {
  return Math.min(HARDENING_RETRY_FLOOR_MS * 2 ** (attempts - 1), HARDENING_RETRY_CEILING_MS)
}

let hardeningFailures: SecurePathHardeningCache<HardeningFailureRecord> | null = null

/** Default independently of import order; an unconfigured second importer previously threw inside async hardening and crashed main. */
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
