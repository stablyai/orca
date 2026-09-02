import { countLooseRefs } from './loose-ref-count'
import { PackedRefsLockGate } from './packed-refs-lock-gate'
import {
  LOOSE_REF_PACK_THRESHOLD,
  REF_MAINTENANCE_ATTEMPT_DEADLINE_MS,
  REF_MAINTENANCE_CLEAN_COOLDOWN_MS,
  REF_MAINTENANCE_FAILURE_COOLDOWN_MS,
  REF_MAINTENANCE_PACKED_COOLDOWN_MS,
  REF_MAINTENANCE_QUIET_PERIOD_MS,
  PACKED_REFS_LOCK_WAIT_MS,
  REF_MAINTENANCE_LOCKED_COOLDOWN_MS,
  RefMaintenanceInterrupted,
  RefMaintenanceRepoLocked,
  type RefMaintenanceOutcome,
  type RefMaintenanceSpan,
  type RepoRefMaintenanceOptions,
  type RepoRefMaintenanceTarget
} from './repo-ref-maintenance-policy'

/**
 * The scheduler half of idle loose-ref packing: when to probe, when to pack,
 * when to stand down. The thresholds and the host contract it works against
 * live in `./repo-ref-maintenance-policy`.
 */

/** Give up until the next real activity rather than re-arming forever. */
const MAX_DEFERRALS = 6
/** Each deferral doubles the wait, so a busy app is retried rarely, not hammered. */
const MAX_DEFERRAL_BACKOFF_MULTIPLIER = 8
/** Armed repos are evicted oldest-first past this; the next write on one re-arms it. */
const MAX_TRACKED_REPOS = 64

type TrackedRepo = {
  target: RepoRefMaintenanceTarget
  timer: ReturnType<typeof setTimeout> | null
  deferrals: number
}

const noopSpan: RefMaintenanceSpan = { setAttribute: () => {} }

/** A deadline means something is stuck: back off instead of retrying straight away. */
function hitDeadline(signal: AbortSignal): boolean {
  return signal.reason instanceof RefMaintenanceInterrupted && signal.reason.deadline
}

export class RepoRefMaintenance {
  private readonly tracked = new Map<string, TrackedRepo>()
  private readonly cooldownUntil = new Map<string, number>()
  private readonly now: () => number
  private readonly isAppBusy: () => boolean
  private readonly observe: NonNullable<RepoRefMaintenanceOptions['observe']>
  private readonly quietPeriodMs: number
  private readonly looseRefThreshold: number
  private readonly onError: (error: unknown) => void
  // Why: at most one pack-refs anywhere. It holds a general git admission slot
  // for its whole run, and two at once would halve git throughput on a small host.
  // The slot is never released while a pack that could hold `packed-refs.lock`
  // is still running -- an interrupt cancels the work and waits for it to stop.
  private inFlight: Promise<void> | null = null
  private inFlightAbort: AbortController | null = null
  private readonly lockGate = new PackedRefsLockGate()
  // Why a count, not a flag: several ref-touching operations overlap routinely
  // (a create's fetch inside a create), and the last one out reopens the window.
  private suspensions = 0
  private lastAttempt: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: RepoRefMaintenanceOptions = {}) {
    this.now = options.now ?? Date.now
    this.isAppBusy = options.isBusy ?? (() => false)
    this.observe = options.observe ?? ((attempt) => attempt(noopSpan))
    this.quietPeriodMs = options.quietPeriodMs ?? REF_MAINTENANCE_QUIET_PERIOD_MS
    this.looseRefThreshold = options.looseRefThreshold ?? LOOSE_REF_PACK_THRESHOLD
    this.onError = options.onError ?? (() => {})
  }

  /**
   * Record a write to `target`'s repo and (re)start its quiet-period countdown.
   * Every call pushes the attempt further out, so a burst of fetches or a
   * worktree create can never be interrupted by maintenance it triggered.
   */
  arm(target: RepoRefMaintenanceTarget): void {
    if (this.disposed) {
      return
    }
    const existing = this.tracked.get(target.key)
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    const tracked: TrackedRepo = { target, timer: null, deferrals: existing?.deferrals ?? 0 }
    this.tracked.delete(target.key)
    this.evictOldestBeyondCap()
    this.tracked.set(target.key, tracked)
    this.schedule(target.key, tracked)
  }

  /** Resolves once the attempt started by the most recent timer has settled. */
  whenAttemptSettled(): Promise<void> {
    return this.lastAttempt
  }

  /**
   * Wait out the `packed-refs` rewrite, if one is in progress.
   *
   * Deliberately not a kill. The lock is held for 0.03-1.37s of a 23-32s pack;
   * the rest is the prune phase, during which a concurrent `fetch --prune`,
   * `branch -D` or `update-ref` measurably succeeds because per-ref locks last
   * microseconds and Git retries for `core.filesRefLockTimeout`. Signalling the
   * child there buys nothing and strands a lock file about one time in five.
   *
   * Free when no pack is running, which is almost always.
   */
  awaitPackedRefsLockRelease(): Promise<void> {
    return this.lockGate.whenReleased(PACKED_REFS_LOCK_WAIT_MS)
  }

  /**
   * Push every armed repository's attempt out by a full quiet period.
   *
   * User-initiated ref work is evidence the user is active in the app, not just
   * in one repo, and it is free -- no key to resolve, no subprocess, nothing at
   * all when nothing is armed.
   */
  postponeAll(): void {
    if (this.disposed) {
      return
    }
    for (const [key, tracked] of this.tracked) {
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
      tracked.deferrals = 0
      this.schedule(key, tracked)
    }
  }

  /**
   * Hold the repository open for work that is about to touch refs.
   *
   * Two things at once: no *new* attempt can start for any repository until the
   * returned release is called, and the caller waits out any `packed-refs`
   * rewrite already in progress. A prune already running is left alone to
   * finish -- it does not block the caller.
   */
  async pause(_reason: string): Promise<() => void> {
    this.suspensions += 1
    let released = false
    try {
      await this.awaitPackedRefsLockRelease()
    } catch {
      // The wait cannot reject, but a release must exist even if it did.
    }
    return () => {
      if (!released) {
        released = true
        this.suspensions -= 1
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.inFlightAbort?.abort(new RefMaintenanceInterrupted('disposed'))
    for (const tracked of this.tracked.values()) {
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
    }
    this.tracked.clear()
    this.cooldownUntil.clear()
  }

  private isBusy(tracked: TrackedRepo): boolean {
    return this.isAppBusy() || (tracked.target.isBusy?.() ?? false)
  }

  private schedule(key: string, tracked: TrackedRepo, delayMs = this.quietPeriodMs): void {
    const timer = setTimeout(() => {
      tracked.timer = null
      this.lastAttempt = this.attempt(key).catch((error) => this.onError(error))
    }, delayMs)
    // Never hold the process open for maintenance.
    timer.unref?.()
    tracked.timer = timer
  }

  private evictOldestBeyondCap(): void {
    while (this.tracked.size >= MAX_TRACKED_REPOS) {
      const oldest = this.tracked.keys().next()
      if (oldest.done) {
        return
      }
      const evicted = this.tracked.get(oldest.value)
      if (evicted?.timer) {
        clearTimeout(evicted.timer)
      }
      this.tracked.delete(oldest.value)
    }
  }

  /**
   * `counted` spends the give-up budget. Waiting behind another repository's
   * pack, or yielding to work Orca asked us to yield to, does not: both end on
   * their own, so charging for them would let a busy machine starve a repo
   * until its next fetch. Only "the app is busy" is charged.
   */
  private defer(key: string, tracked: TrackedRepo, counted: boolean): void {
    // A fetch that landed while this attempt was probing already re-armed the
    // repo; that entry is fresher, so the deferral must not overwrite it.
    if (this.disposed || this.tracked.has(key)) {
      return
    }
    if (counted) {
      if (tracked.deferrals >= MAX_DEFERRALS) {
        return
      }
      tracked.deferrals += 1
    }
    this.tracked.set(key, tracked)
    const multiplier = Math.min(2 ** tracked.deferrals, MAX_DEFERRAL_BACKOFF_MULTIPLIER)
    this.schedule(key, tracked, this.quietPeriodMs * multiplier)
  }

  private async attempt(key: string): Promise<void> {
    const tracked = this.tracked.get(key)
    if (!tracked || this.disposed) {
      return
    }
    this.tracked.delete(key)
    const cooldownUntil = this.cooldownUntil.get(key)
    if (cooldownUntil !== undefined && this.now() < cooldownUntil) {
      return
    }
    if (this.inFlight !== null) {
      this.defer(key, tracked, false)
      return
    }
    if (this.suspensions > 0 || this.isBusy(tracked)) {
      this.defer(key, tracked, true)
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(
      () => abort.abort(new RefMaintenanceInterrupted('attempt deadline', true)),
      REF_MAINTENANCE_ATTEMPT_DEADLINE_MS
    )
    deadline.unref?.()
    const run = this.observe((span) => this.packIfNeeded(key, tracked, span, abort.signal))
    this.inFlight = run
    this.inFlightAbort = abort
    try {
      await run
    } finally {
      clearTimeout(deadline)
      if (this.inFlight === run) {
        this.inFlight = null
        this.inFlightAbort = null
      }
    }
  }

  private async packIfNeeded(
    key: string,
    tracked: TrackedRepo,
    span: RefMaintenanceSpan,
    signal: AbortSignal
  ): Promise<void> {
    span.setAttribute('repo.maintenance_key', key)
    // Every await below carries the signal, so a caller waiting in `pause()` is
    // never stuck behind a probe that has already been told to stop.
    if (await tracked.target.isOptedOut?.(signal)) {
      this.settle(key, span, 'opted_out', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    if (signal.aborted) {
      this.yieldTo(key, tracked, span, signal)
      return
    }
    const refsDirectory = await tracked.target.resolveRefsDirectory(signal)
    if (!refsDirectory) {
      this.settle(key, span, 'unresolved', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    const budget = this.looseRefThreshold + 1
    const before = await countLooseRefs(refsDirectory, budget, signal)
    if (signal.aborted) {
      this.yieldTo(key, tracked, span, signal)
      return
    }
    span.setAttribute('git.loose_ref_count', before.count)
    span.setAttribute('git.loose_ref_threshold', this.looseRefThreshold)
    // A saturated walk stopped early, so `count` is a floor -- never read it as "clean".
    if (!before.saturated && before.count < this.looseRefThreshold) {
      this.settle(key, span, 'below_threshold', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    // The quiet window can close while the probe walks; re-check before spending a git slot.
    if (this.suspensions > 0 || this.isBusy(tracked)) {
      span.setAttribute('repo.maintenance_outcome', 'deferred' satisfies RefMaintenanceOutcome)
      this.defer(key, tracked, true)
      return
    }
    const startedAt = this.now()
    let partial = false
    try {
      // No signal: the pack runs to completion. Callers that need the refs wait
      // out the rewrite window through `pause()` instead of killing it.
      await tracked.target.packRefs(this.lockGate)
    } catch (error) {
      span.setAttribute('repo.maintenance_error', String(error))
      if (error instanceof RefMaintenanceRepoLocked) {
        this.settle(key, span, 'locked', REF_MAINTENANCE_LOCKED_COOLDOWN_MS)
        return
      }
      partial = true
    } finally {
      this.lockGate.setHeld(false)
    }
    span.setAttribute('git.pack_refs_ms', this.now() - startedAt)
    // Judge by the backlog, not by the exit code. On a machine running several
    // Orca sessions a branch moving mid-pack is the normal case, and Git's
    // response -- leave that one ref loose, pack the rest -- is the correct one.
    // Measured in the field: 36,688 loose refs down to 3, reported as an error.
    const after = await countLooseRefs(refsDirectory, budget, signal)
    span.setAttribute('git.loose_ref_count_after', after.count)
    if (partial && (after.saturated || after.count >= this.looseRefThreshold)) {
      this.settle(key, span, 'failed', REF_MAINTENANCE_FAILURE_COOLDOWN_MS)
      return
    }
    span.setAttribute('git.pack_refs_partial', partial)
    this.settle(key, span, 'packed', REF_MAINTENANCE_PACKED_COOLDOWN_MS)
  }

  /** Record an aborted attempt: retry soon if Orca yielded, back off if it stalled. */
  private yieldTo(
    key: string,
    tracked: TrackedRepo,
    span: RefMaintenanceSpan,
    signal: AbortSignal
  ): void {
    if (hitDeadline(signal)) {
      this.settle(key, span, 'timed_out', REF_MAINTENANCE_FAILURE_COOLDOWN_MS)
      return
    }
    span.setAttribute('repo.maintenance_outcome', 'interrupted' satisfies RefMaintenanceOutcome)
    this.defer(key, tracked, false)
  }

  private settle(
    key: string,
    span: RefMaintenanceSpan,
    outcome: RefMaintenanceOutcome,
    cooldownMs: number
  ): void {
    span.setAttribute('repo.maintenance_outcome', outcome)
    // Re-insert so Map order stays newest-last and the eviction below drops the oldest.
    this.cooldownUntil.delete(key)
    this.cooldownUntil.set(key, this.now() + cooldownMs)
    if (this.cooldownUntil.size > MAX_TRACKED_REPOS * 4) {
      const oldest = this.cooldownUntil.keys().next()
      if (!oldest.done) {
        this.cooldownUntil.delete(oldest.value)
      }
    }
  }
}
