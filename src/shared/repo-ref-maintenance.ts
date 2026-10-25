import { countLooseRefs } from './loose-ref-count'
import { PackedRefsLockGate } from './packed-refs-lock-gate'
import { RepoMaintenanceSchedule } from './repo-maintenance-schedule'
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
  superseded?: boolean
}

const noopSpan: RefMaintenanceSpan = { setAttribute: () => {} }

export class RepoRefMaintenance {
  private readonly tracked = new Map<string, TrackedRepo>()
  private readonly phases: RepoMaintenanceSchedule
  private readonly now: () => number
  private readonly isAppBusy: () => boolean
  private readonly observe: NonNullable<RepoRefMaintenanceOptions['observe']>
  private readonly quietPeriodMs: number
  private readonly looseRefThreshold: number
  private readonly onError: (error: unknown) => void
  // One app-wide pack avoids starving foreground Git; keep its slot until interrupted work has stopped.
  private inFlight: Promise<void> | null = null
  private inFlightAbort: AbortController | null = null
  private inFlightTracked: TrackedRepo | null = null
  private readonly lockGate = new PackedRefsLockGate()
  // Overlapping ref operations share the pause; only the last release reopens maintenance.
  private suspensions = 0
  private lastAttempt: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: RepoRefMaintenanceOptions = {}) {
    this.now = options.now ?? Date.now
    this.phases = new RepoMaintenanceSchedule(this.now)
    this.isAppBusy = options.isBusy ?? (() => false)
    this.observe = options.observe ?? ((attempt) => attempt(noopSpan))
    this.quietPeriodMs = options.quietPeriodMs ?? REF_MAINTENANCE_QUIET_PERIOD_MS
    this.looseRefThreshold = options.looseRefThreshold ?? LOOSE_REF_PACK_THRESHOLD
    this.onError = options.onError ?? (() => {})
  }

  /** Restart the quiet countdown on every write so maintenance cannot interrupt the burst that armed it. */
  arm(target: RepoRefMaintenanceTarget): void {
    if (this.disposed) {
      return
    }
    // Invalidation survives eviction of the replacement quiet-period timer.
    if (this.inFlightTracked?.target.key === target.key) {
      this.inFlightTracked.superseded = true
    }
    const existing = this.tracked.get(target.key)
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    const tracked: TrackedRepo = { target, timer: null, deferrals: existing?.deferrals ?? 0 }
    this.tracked.delete(target.key)
    while (this.tracked.size >= MAX_TRACKED_REPOS) {
      const oldest = this.tracked.keys().next()
      if (oldest.done) {
        break
      }
      const evicted = this.tracked.get(oldest.value)
      if (evicted?.timer) {
        clearTimeout(evicted.timer)
      }
      this.tracked.delete(oldest.value)
    }
    this.tracked.set(target.key, tracked)
    this.schedule(target.key, tracked)
  }

  /** Resolves once the attempt started by the most recent timer has settled. */
  whenAttemptSettled(): Promise<void> {
    return this.lastAttempt
  }

  /** Wait out the short rewrite instead of killing the pack: concurrent ref edits succeed during pruning,
   * while killing can strand packed-refs.lock (observed roughly one in five kills). */
  awaitPackedRefsLockRelease(): Promise<void> {
    return this.lockGate.whenReleased(PACKED_REFS_LOCK_WAIT_MS)
  }

  /** User ref work proves app-wide activity; postpone all armed repos without resolving individual targets. */
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

  /** Block new attempts until release and await any packed-refs rewrite; ongoing pruning can finish concurrently. */
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
    this.phases.clear()
  }

  private isBusy(tracked: TrackedRepo): boolean {
    return tracked.superseded || this.isAppBusy() || (tracked.target.isBusy?.() ?? false)
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

  /** Charge only activity/failed probes against the give-up budget; waiting behind other packs or requested yields
   * ends independently and must not starve maintenance until the next fetch. */
  private defer(key: string, tracked: TrackedRepo, counted: boolean): void {
    // Do not overwrite a fresher arm from a fetch that landed during the probe.
    if (this.disposed || tracked.superseded || this.tracked.has(key)) {
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
    const refDueAt = this.phases.refDueAt(key)
    const indexDueAt = tracked.target.maintainPackIndex ? this.phases.indexDueAt(key) : refDueAt
    const nextDueAt = Math.min(refDueAt, indexDueAt)
    if (this.now() < nextDueAt) {
      this.tracked.set(key, tracked)
      this.schedule(key, tracked, nextDueAt - this.now())
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
    this.inFlightTracked = tracked
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
        this.inFlightTracked = null
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
    const canWrite = () => !signal.aborted && this.suspensions === 0 && !this.isBusy(tracked)
    // Probes are cancellable; admitted index and ref writers finish before releasing the slot.
    const optedOut = await this.phases.probeOptOut(tracked.target, signal, span, canWrite)
    if (signal.aborted) {
      return this.yieldTo(key, tracked, span, signal)
    }
    if (typeof optedOut === 'object') {
      this.defer(key, tracked, true)
      throw optedOut.error
    }
    if (optedOut) {
      return
    }
    if (this.suspensions > 0 || this.isBusy(tracked)) {
      return this.yieldTo(key, tracked, span, signal)
    }
    const indexOutcome = await this.phases.maintain(tracked.target, signal, span, canWrite)
    if (indexOutcome === 'deferred' || !canWrite()) {
      return this.yieldTo(key, tracked, span, signal)
    }
    if (this.now() < this.phases.refDueAt(key)) {
      span.setAttribute('repo.maintenance_outcome', 'index_only' satisfies RefMaintenanceOutcome)
      // Keep the arm for its ref phase; the write that armed it may have left loose refs.
      if (!this.disposed && !this.tracked.has(key)) {
        this.tracked.set(key, tracked)
        this.schedule(key, tracked, this.phases.refDueAt(key) - this.now())
      }
      return
    }
    const refsDirectory = await tracked.target.resolveRefsDirectory(signal)
    if (!canWrite()) {
      return this.yieldTo(key, tracked, span, signal)
    }
    if (!refsDirectory) {
      this.phases.settleRefs(key, span, 'unresolved', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    const budget = this.looseRefThreshold + 1
    const before = await countLooseRefs(refsDirectory, budget, signal)
    if (!canWrite()) {
      return this.yieldTo(key, tracked, span, signal)
    }
    span.setAttribute('git.loose_ref_count', before.count)
    span.setAttribute('git.loose_ref_threshold', this.looseRefThreshold)
    // A saturated walk stopped early, so `count` is a floor -- never read it as "clean".
    if (!before.saturated && before.count < this.looseRefThreshold) {
      this.phases.settleRefs(key, span, 'below_threshold', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    const startedAt = this.now()
    let partial = false
    try {
      // Only admission cancels; pause waits out the rewrite instead of killing the writer.
      await tracked.target.packRefs(this.lockGate, signal, canWrite)
    } catch (error) {
      span.setAttribute('repo.maintenance_error', String(error))
      if (!canWrite()) {
        return this.yieldTo(key, tracked, span, signal)
      }
      if (error instanceof RefMaintenanceRepoLocked) {
        this.phases.settleRefs(key, span, 'locked', REF_MAINTENANCE_LOCKED_COOLDOWN_MS)
        return
      }
      partial = true
    } finally {
      this.lockGate.setHeld(false)
    }
    span.setAttribute('git.pack_refs_ms', this.now() - startedAt)
    if (!canWrite()) {
      return this.yieldTo(key, tracked, span, signal)
    }
    // Judge the remaining backlog: concurrent ref movement may report failure after packing almost everything.
    const after = await countLooseRefs(refsDirectory, budget, signal)
    if (!canWrite()) {
      return this.yieldTo(key, tracked, span, signal)
    }
    span.setAttribute('git.loose_ref_count_after', after.count)
    if (partial && (after.saturated || after.count >= this.looseRefThreshold)) {
      this.phases.settleRefs(key, span, 'failed', REF_MAINTENANCE_FAILURE_COOLDOWN_MS)
      return
    }
    span.setAttribute('git.pack_refs_partial', partial)
    this.phases.settleRefs(key, span, 'packed', REF_MAINTENANCE_PACKED_COOLDOWN_MS)
  }

  /** Retry ineligible work; back off only for activity or deadlines. */
  private yieldTo(
    key: string,
    tracked: TrackedRepo,
    span: RefMaintenanceSpan,
    signal: AbortSignal
  ): void {
    if (!signal.aborted || tracked.superseded) {
      span.setAttribute('repo.maintenance_outcome', 'deferred' satisfies RefMaintenanceOutcome)
      this.defer(key, tracked, true)
      return
    }
    if (signal.reason instanceof RefMaintenanceInterrupted && signal.reason.deadline) {
      this.phases.settleRefs(key, span, 'timed_out', REF_MAINTENANCE_FAILURE_COOLDOWN_MS)
      return
    }
    span.setAttribute('repo.maintenance_outcome', 'interrupted' satisfies RefMaintenanceOutcome)
    this.defer(key, tracked, false)
  }
}
