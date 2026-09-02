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
 * A repository whose `packed-refs.lock` is a strand from our own dead process
 * becomes reclaimable at `PACK_REFS_TIMEOUT_MS`, so retry near that rather than
 * serving the full failure cooldown -- otherwise a Windows force-kill leaves
 * every ref deletion in that repo failing for six hours instead of thirty
 * minutes.
 */
export const REF_MAINTENANCE_LOCKED_COOLDOWN_MS = 30 * 60_000

/**
 * `pack-refs` holds `packed-refs.lock` only while it rewrites the file --
 * measured at 0.03-1.37s of a 23-32s run, the other ~95% being the prune phase
 * unlinking loose refs. A caller about to touch refs waits out that window
 * instead of killing the pack.
 */
export const PACKED_REFS_LOCK_POLL_MS = 50

/**
 * Ceiling on that wait. Past this we stop blocking the user and let Git's own
 * retry (`core.filesRefLockTimeout`, `core.packedRefsTimeout`) handle it, which
 * is what happens today without any of this.
 */
export const PACKED_REFS_LOCK_WAIT_MS = 5_000

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
 * Backstop on a whole attempt: aborts it, rather than abandoning it. Every Git
 * child is already deadlined, but an admission wait is not, and the whole app
 * shares one maintenance slot. Abandoning would release that slot while a pack
 * that may still hold `packed-refs.lock` runs on, so the deadline cancels the
 * work instead and the slot is held until it really stops.
 */
export const REF_MAINTENANCE_ATTEMPT_DEADLINE_MS = PACK_REFS_TIMEOUT_MS + 5 * 60_000

export type RefMaintenanceOutcome =
  | 'packed'
  | 'below_threshold'
  | 'unresolved'
  | 'opted_out'
  | 'deferred'
  | 'interrupted'
  | 'locked'
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
  resolveRefsDirectory(signal: AbortSignal): Promise<string | undefined>
  /** A user who told Git not to auto-maintain this repo has told Orca too. */
  isOptedOut?(signal: AbortSignal): Promise<boolean>
  /** True while work on *this repo* is in flight -- a fetch, a create, a removal. */
  isBusy?(): boolean
  /**
   * Runs `pack-refs` to completion. Deliberately takes no abort signal: killing
   * a pack is measurably worse than waiting for it (see `PACKED_REFS_LOCK_*`).
   * It must report `packed-refs.lock` transitions through `lock` so callers can
   * wait for the short window that actually blocks them.
   */
  packRefs(lock: PackedRefsLockReporter): Promise<void>
}

/** How `packRefs` tells the scheduler whether the exclusive write window is open. */
export type PackedRefsLockReporter = {
  setHeld(held: boolean): void
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

/** Marks an abort Orca asked for, so the attempt is retried rather than blamed on the repo. */
export class RefMaintenanceInterrupted extends Error {
  constructor(
    reason: string,
    /** True when the attempt ran out of time rather than yielding to real work. */
    readonly deadline = false
  ) {
    super(`Ref maintenance interrupted: ${reason}`)
    this.name = 'RefMaintenanceInterrupted'
  }
}

/**
 * The repository's `packed-refs.lock` is held by something we must not touch.
 * Distinct from a failure so a strand our own dead process left can be retried
 * once it ages into reclaimability, rather than parked for six hours.
 */
export class RefMaintenanceRepoLocked extends Error {
  constructor(detail: string) {
    super(`packed-refs.lock is held: ${detail}`)
    this.name = 'RefMaintenanceRepoLocked'
  }
}
