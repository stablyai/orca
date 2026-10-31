import type { PackIndexMaintenanceOutcome } from './repo-pack-index-maintenance-policy'

/** Compensate for Orca fetches disabling Git auto-maintenance: pack loose refs after a quiet period.
 * Execution hosts own Git/filesystem access and supply host-scoped target identities. */

/** Conservative threshold for unsolicited maintenance; well above Git 2.47’s files-backend heuristic
 * (~76 refs for the motivating 4.1 MB packed-refs). Packing smaller backlogs costs more than it saves. */
export const LOOSE_REF_PACK_THRESHOLD = 1000

/** No fetch, create, or other tracked write on the repo for this long. */
export const REF_MAINTENANCE_QUIET_PERIOD_MS = 10 * 60_000

/** Packing empties the backlog; there is nothing to do again for a long while. */
export const REF_MAINTENANCE_PACKED_COOLDOWN_MS = 12 * 60 * 60_000

/** A healthy or unresolvable repo should not be re-probed on every quiet window. */
export const REF_MAINTENANCE_CLEAN_COOLDOWN_MS = 6 * 60 * 60_000

/** A failing repo (permissions, stale lock) must not be retried in a loop. */
export const REF_MAINTENANCE_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000

/** Retry near PACK_REFS_TIMEOUT_MS, when our dead process’s lock becomes reclaimable, rather than blocking ref edits for six hours. */
export const REF_MAINTENANCE_LOCKED_COOLDOWN_MS = 30 * 60_000

/** Wait out the short packed-refs rewrite (measured 0.03–1.37s), rather than killing a mostly-pruning pack. */
export const PACKED_REFS_LOCK_POLL_MS = 50

/** After this wait, rely on Git’s core.filesRefLockTimeout/core.packedRefsTimeout retries. */
export const PACKED_REFS_LOCK_WAIT_MS = 5_000

/** Leave margin for cold-disk pruning (36k refs took ~83s on APFS). Mid-pack kills preserve ref data
 * via atomic packed-refs replacement and authoritative loose refs, but waste work. */
export const PACK_REFS_TIMEOUT_MS = 15 * 60_000

/** Git 2.25-compatible; --all includes heads/remotes. --auto requires 2.45 and rewrites unconditionally
 * before 2.47; git maintenance adds unrelated work. */
export const PACK_REFS_ARGS = ['pack-refs', '--all', '--prune'] as const

/** Bound admission too; cancel and await work before releasing the app-wide slot, or a pack may keep its lock while another starts. */
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
  | 'index_only'

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
  /** Repair object lookup metadata before counting refs, under the same idle admission. */
  maintainPackIndex?(
    signal: AbortSignal,
    span: RefMaintenanceSpan,
    canWrite: () => boolean
  ): Promise<PackIndexMaintenanceOutcome | void>
  /** Run to completion: signal cancels admission only. Report packed-refs.lock transitions so callers can wait out the rewrite. */
  packRefs(
    lock: PackedRefsLockReporter,
    admissionSignal?: AbortSignal,
    canStart?: () => boolean
  ): Promise<void>
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

/** Retry foreign or stranded locks when reclaimable, separately from the six-hour failure cooldown. */
export class RefMaintenanceRepoLocked extends Error {
  constructor(detail: string) {
    super(`packed-refs.lock is held: ${detail}`)
    this.name = 'RefMaintenanceRepoLocked'
  }
}
