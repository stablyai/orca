import { countLooseRefs } from './loose-ref-count'

/**
 * Idle-time loose-ref packing for repositories Orca itself degrades.
 *
 * Orca strips git's auto-maintenance off its own frequent fetches
 * (`GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS`) and never compensated, so an
 * Orca-driven checkout accumulates loose refs forever and every ref
 * enumeration -- `show-ref`, `for-each-ref`, worktree create -- pays for them.
 * This is the compensation: after a repo goes quiet, probe it, and pack only
 * when the backlog is real.
 *
 * The engine is host-agnostic on purpose. The execution host owns everything
 * that touches execution, so each host supplies its own target (which git to
 * run, which filesystem to walk) and all state here is keyed per host.
 */

/**
 * Below this, ref enumeration is already fast and `pack-refs` would cost more
 * than it saves.
 *
 * Git's own files-backend auto heuristic (2.47+) packs at
 * `max(16, log2(packed_refs_bytes / 100) * 5)` loose refs -- about 76 for the
 * 4.1 MB `packed-refs` that motivated this work. A flat 1000 is roughly an
 * order of magnitude more conservative on purpose: this runs unasked against a
 * real checkout, and being late is cheap where being wrong is not.
 */
export const LOOSE_REF_PACK_THRESHOLD = 1000

/** No fetch, create, or other tracked write on the repo for this long. */
export const REF_MAINTENANCE_QUIET_PERIOD_MS = 10 * 60_000

/** Packing empties the backlog; there is nothing to do again for a long while. */
export const REF_MAINTENANCE_PACKED_COOLDOWN_MS = 12 * 60 * 60_000

/** A healthy or unresolvable repo should not be re-probed on every quiet window. */
export const REF_MAINTENANCE_CLEAN_COOLDOWN_MS = 6 * 60 * 60_000

/** A failing repo (permissions, stale lock) must not be retried in a loop. */
export const REF_MAINTENANCE_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000

/**
 * `pack-refs --prune` unlinks one file per loose ref. Paying off a 36k-ref
 * backlog measured at ~83s on APFS, so the deadline has to clear a cold repo on
 * a slow disk by a wide margin. A kill mid-run is safe -- git renames
 * `packed-refs` into place atomically and the surviving loose refs stay
 * authoritative -- but it wastes the work.
 */
export const PACK_REFS_TIMEOUT_MS = 15 * 60_000

/**
 * Ancient, safe on the Git 2.25 baseline, and does exactly one thing.
 *
 * Not `pack-refs --auto`: that arrived in 2.45 and unconditionally rewrote
 * `packed-refs` on the files backend until 2.47, so it is both unavailable at
 * our baseline and wrong on two shipped releases. Not `git maintenance run`
 * either -- newer, and it pulls in commit-graph and repack work we did not ask
 * for. `--all` is required because the backlog is `refs/heads` and
 * `refs/remotes`, which a bare `pack-refs` leaves alone.
 */
export const PACK_REFS_ARGS = ['pack-refs', '--all', '--prune'] as const

/**
 * Backstop on a whole attempt. Every Git child is already deadlined, but
 * `opendir` on a hung network or WSL share never settles and neither does an
 * admission wait -- and the whole app shares one maintenance slot, so one hang
 * would otherwise wedge every repository for the life of the process.
 */
export const REF_MAINTENANCE_ATTEMPT_DEADLINE_MS = PACK_REFS_TIMEOUT_MS + 5 * 60_000

/** Give up until the next real activity rather than re-arming forever. */
const MAX_DEFERRALS = 6
/** Each deferral doubles the wait, so a busy app is retried rarely, not hammered. */
const MAX_DEFERRAL_BACKOFF_MULTIPLIER = 8
/** Armed repos are evicted oldest-first past this; the next write on one re-arms it. */
const MAX_TRACKED_REPOS = 64

export type RefMaintenanceOutcome =
  | 'packed'
  | 'below_threshold'
  | 'unresolved'
  | 'opted_out'
  | 'deferred'
  | 'timed_out'
  | 'failed'

/** Structurally satisfied by the tracer's `ActiveSpan`. */
export type RefMaintenanceSpan = {
  setAttribute(key: string, value: unknown): void
}

export type RepoRefMaintenanceTarget = {
  /** Repo identity scoped to its execution host; all state here is keyed by it. */
  readonly key: string
  /** Absolute `refs/` path *on the host that runs the walk*, or undefined if unresolvable. */
  resolveRefsDirectory(): Promise<string | undefined>
  /** A user who told Git not to auto-maintain this repo has told Orca too. */
  isOptedOut?(): Promise<boolean>
  /** True while work on *this repo* is in flight -- a fetch, a create, a removal. */
  isBusy?(): boolean
  packRefs(): Promise<void>
}

export type RepoRefMaintenanceOptions = {
  now?: () => number
  /** True while app-wide work this must not race is in flight (create, live agent, battery, quit). */
  isBusy?: () => boolean
  /** Wraps one attempt so a host can trace it; must invoke and await `attempt`. */
  observe?: (attempt: (span: RefMaintenanceSpan) => Promise<void>) => Promise<void>
  quietPeriodMs?: number
  looseRefThreshold?: number
  onError?: (error: unknown) => void
}

type TrackedRepo = {
  target: RepoRefMaintenanceTarget
  timer: ReturnType<typeof setTimeout> | null
  deferrals: number
}

const noopSpan: RefMaintenanceSpan = { setAttribute: () => {} }

/** True if `work` settled first. The abandoned work keeps running; it just stops blocking. */
async function settlesWithin(work: Promise<void>, deadlineMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work.then(() => true), deadline])
  } finally {
    clearTimeout(timer)
  }
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
  private inFlight: Promise<void> | null = null
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

  dispose(): void {
    this.disposed = true
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

  private defer(key: string, tracked: TrackedRepo): void {
    // A fetch that landed while this attempt was probing already re-armed the
    // repo; that entry is fresher, so the deferral must not overwrite it.
    if (this.disposed || this.tracked.has(key) || tracked.deferrals >= MAX_DEFERRALS) {
      return
    }
    tracked.deferrals += 1
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
    if (this.inFlight !== null || this.isBusy(tracked)) {
      this.defer(key, tracked)
      return
    }
    const run = this.observe(async (span) => {
      const settled = await settlesWithin(
        this.packIfNeeded(key, tracked, span),
        REF_MAINTENANCE_ATTEMPT_DEADLINE_MS
      )
      if (!settled) {
        this.settle(key, span, 'timed_out', REF_MAINTENANCE_FAILURE_COOLDOWN_MS)
      }
    })
    this.inFlight = run
    try {
      await run
    } finally {
      if (this.inFlight === run) {
        this.inFlight = null
      }
    }
  }

  private async packIfNeeded(
    key: string,
    tracked: TrackedRepo,
    span: RefMaintenanceSpan
  ): Promise<void> {
    span.setAttribute('repo.maintenance_key', key)
    if (await tracked.target.isOptedOut?.()) {
      this.settle(key, span, 'opted_out', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    const refsDirectory = await tracked.target.resolveRefsDirectory()
    if (!refsDirectory) {
      this.settle(key, span, 'unresolved', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    const budget = this.looseRefThreshold + 1
    const before = await countLooseRefs(refsDirectory, budget)
    span.setAttribute('git.loose_ref_count', before.count)
    span.setAttribute('git.loose_ref_threshold', this.looseRefThreshold)
    // A saturated walk stopped early, so `count` is a floor -- never read it as "clean".
    if (!before.saturated && before.count < this.looseRefThreshold) {
      this.settle(key, span, 'below_threshold', REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
      return
    }
    // The quiet window can close while the probe walks; re-check before spending a git slot.
    if (this.isBusy(tracked)) {
      span.setAttribute('repo.maintenance_outcome', 'deferred' satisfies RefMaintenanceOutcome)
      this.defer(key, tracked)
      return
    }
    const startedAt = this.now()
    try {
      await tracked.target.packRefs()
    } catch (error) {
      span.setAttribute('repo.maintenance_error', String(error))
      this.settle(key, span, 'failed', REF_MAINTENANCE_FAILURE_COOLDOWN_MS)
      return
    }
    span.setAttribute('git.pack_refs_ms', this.now() - startedAt)
    span.setAttribute(
      'git.loose_ref_count_after',
      (await countLooseRefs(refsDirectory, budget)).count
    )
    this.settle(key, span, 'packed', REF_MAINTENANCE_PACKED_COOLDOWN_MS)
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
