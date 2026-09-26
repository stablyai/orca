/**
 * Idle-time repository maintenance for checkouts Orca itself degrades.
 *
 * Orca strips git's auto-maintenance off its own frequent fetches
 * (`GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS`) and never compensated, so an
 * Orca-driven checkout accumulates backlog forever: loose refs, which every ref
 * enumeration -- `show-ref`, `for-each-ref`, worktree create -- pays for, and
 * loose objects, which Orca writes itself (`merge-tree --write-tree` leaves
 * about six unreachable objects behind per divergent conflict summary). This is
 * the compensation: after a repo goes quiet, probe it, and pack only when the
 * backlog is real.
 *
 * Both are the same schedule deliberately. A second sweep beside this one would
 * need its own quiet period, its own busy gate and its own admission slot, and
 * the two would then race for the one git slot they share. They are tasks on one
 * schedule instead, run in a fixed order within a single attempt.
 *
 * The engine is host-agnostic on purpose. The execution host owns everything
 * that touches execution, so each host supplies its own tasks (which git to run,
 * which filesystem to walk) and all state here is keyed per host.
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

/**
 * Below this, the loose-object store costs nothing worth a pack.
 *
 * Git's own `gc.auto` fires a full `gc` at 6700 loose objects, and that is the
 * number that has to be stayed under: past it, every git command that runs auto
 * maintenance starts a full `gc`, and a `gc` cannot pack objects that are both
 * unreachable and younger than `gc.pruneExpire` -- it can neither fold them into
 * a pack nor delete them, so the count never falls and the next command starts
 * another one. Field-observed: a 4.6 GB repo with 802 worktrees sat at ~8600
 * such objects, re-running a 40-minute `gc` continuously. 1000 leaves most of
 * git's own headroom intact while still being far above ordinary churn.
 */
export const LOOSE_OBJECT_PACK_THRESHOLD = 1000

/**
 * Objects packed per attempt. The whole app shares one maintenance slot, so a
 * repo with a million loose objects must not hold it for the length of a single
 * `pack-objects` over all of them; it pays down a batch, and the scheduler
 * re-arms for the remainder. Sized against the field measurement above -- ~8600
 * objects packed in 6s -- so one batch stays in the seconds, not minutes.
 */
export const LOOSE_OBJECT_PACK_BATCH = 10_000

/** No fetch, create, or other tracked write on the repo for this long. */
export const REPO_MAINTENANCE_QUIET_PERIOD_MS = 10 * 60_000

/**
 * Re-arm delay after a task paid down a batch and left a remainder.
 *
 * Deliberately far shorter than the quiet period: the repo was quiet moments
 * ago, and the next attempt re-checks the busy gate and the suspension count
 * anyway. At a full quiet period a large backlog would take hours of wall clock
 * to drain, which is long enough for the `gc` loop this exists to break to keep
 * firing the whole time.
 */
export const REPO_MAINTENANCE_REMAINDER_DELAY_MS = 30_000

/**
 * How many times in a row a repo may be re-armed for a remainder before it has
 * to wait for real activity again.
 *
 * The exit on an obligation that would otherwise have none. Every round packs a
 * full batch, so progress already bounds this in each case we know of; the cap
 * covers the case we do not, where a task reports a spent batch round after
 * round without the backlog moving. At the shipped batch size, 64 rounds is
 * over half a million objects in one quiet window, and the next write to the
 * repo clears the counter.
 */
export const REPO_MAINTENANCE_MAX_REMAINDER_ROUNDS = 64

/** Packing empties the backlog; there is nothing to do again for a long while. */
export const REPO_MAINTENANCE_PACKED_COOLDOWN_MS = 12 * 60 * 60_000

/** A healthy or unresolvable repo should not be re-probed on every quiet window. */
export const REPO_MAINTENANCE_CLEAN_COOLDOWN_MS = 6 * 60 * 60_000

/** A failing repo (permissions, stale lock) must not be retried in a loop. */
export const REPO_MAINTENANCE_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000

/**
 * A repository whose `packed-refs.lock` is a strand from our own dead process
 * becomes reclaimable at `PACK_REFS_TIMEOUT_MS`, so retry near that rather than
 * serving the full failure cooldown -- otherwise a Windows force-kill leaves
 * every ref deletion in that repo failing for six hours instead of thirty
 * minutes.
 */
export const REPO_MAINTENANCE_LOCKED_COOLDOWN_MS = 30 * 60_000

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
 * Fold a batch of named loose objects into one pack, without traversal.
 *
 * `pack-objects` reading object ids from stdin, and `prune-packed`, are both
 * far older than the Git 2.25 baseline. `git maintenance run --task=loose-objects`
 * does the same thing, but arrived in 2.30 and is not available to us; `git gc`
 * is the wrong tool outright, because it packs by reachability and therefore
 * cannot touch the unreachable objects that are the whole problem.
 *
 * `--non-empty` so an emptied backlog leaves no zero-object pack behind. No
 * `--revs`: the ids on stdin are the pack, with no history walk at all, which is
 * what keeps this seconds rather than the tens of minutes a `gc` costs.
 */
export const PACK_LOOSE_OBJECTS_ARGS = ['pack-objects', '--quiet', '--non-empty'] as const

/**
 * Base name for the pack written from loose objects, joined onto `objects/pack`.
 * Git names its own loose-object packs the same way, so a reader looking at the
 * pack directory sees the origin of the pack in its file name.
 */
export const LOOSE_OBJECT_PACK_BASE_NAME = 'loose'

/**
 * Delete loose objects that a pack already carries.
 *
 * Run once before packing, so a batch never re-packs what a previous, killed
 * attempt already wrote, and once after, so the backlog this task is judged on
 * actually falls. Git's own `repack -d` prunes immediately after writing its
 * pack in exactly this way: a reader that misses the object in its cached pack
 * list re-reads the pack directory before reporting it missing.
 */
export const PRUNE_PACKED_ARGS = ['prune-packed', '--quiet'] as const

/** One bounded batch, so this is a deadline on seconds of work, not on a backlog. */
export const LOOSE_OBJECT_PACK_TIMEOUT_MS = 5 * 60_000

/**
 * Every pack Orca writes from loose objects carries a `.keep` with exactly this
 * content, and Orca only ever removes a `.keep` that says so.
 *
 * The keep is what makes those packs safe on Git before 2.40, which has no
 * cruft packs by default: there, `gc --auto` repacks with `-A`, which turns the
 * unreachable objects of every unkept pack straight back into loose objects --
 * undoing the pack and re-starting the loop it broke. Kept packs are left alone,
 * and are not counted toward `gc.autoPackLimit` either.
 */
export const LOOSE_OBJECT_PACK_KEEP_CONTENT =
  'orca: loose-object pack, released after gc.pruneExpire\n'

/**
 * Housekeeping on Orca's kept packs is owed as soon as there is any: one keep
 * past its expiry, or two packs that can become one.
 */
export const OBJECT_PACK_HOUSEKEEPING_THRESHOLD = 1

/**
 * A kept pack at or past this many objects is never merged again, so no pack is
 * rewritten over and over as the day's batches land beside it.
 */
export const OBJECT_PACK_MERGE_MAX_OBJECTS = 10 * LOOSE_OBJECT_PACK_BATCH

/** Git's own default for `gc.pruneExpire`, used when the user has not set one. */
export const DEFAULT_GC_PRUNE_EXPIRE_MS = 14 * 24 * 60 * 60_000

/**
 * Backstop on a whole attempt: aborts it, rather than abandoning it. Every Git
 * child is already deadlined, but an admission wait is not, and the whole app
 * shares one maintenance slot. Abandoning would release that slot while a pack
 * that may still hold `packed-refs.lock` runs on, so the deadline cancels the
 * work instead and the slot is held until it really stops.
 */
export const REPO_MAINTENANCE_ATTEMPT_DEADLINE_MS = PACK_REFS_TIMEOUT_MS + 5 * 60_000

/** The tasks one attempt runs, in the order it runs them. */
export type RepoMaintenanceTaskId = 'refs' | 'objects' | 'object-packs'

/** How a single task ended. */
export type RepoMaintenanceTaskOutcome =
  | 'packed'
  | 'partially_packed'
  | 'below_threshold'
  | 'unresolved'
  | 'locked'
  | 'failed'

/** How a whole attempt ended, independently of what any one task decided. */
export type RepoMaintenanceAttemptOutcome =
  | 'completed'
  | 'opted_out'
  | 'deferred'
  | 'interrupted'
  | 'timed_out'

/** Structurally satisfied by the tracer's `ActiveSpan`. */
export type RepoMaintenanceSpan = {
  setAttribute(key: string, value: unknown): void
}

/** What a bounded probe saw. Shared by every task so the scheduler stays task-blind. */
export type RepoMaintenanceBacklog = {
  /** Items seen, never above the probe's budget. */
  count: number
  /** The probe stopped early, so `count` is a floor rather than the total. */
  saturated: boolean
}

/** What one `pack` did, in the only terms the scheduler needs to decide what next. */
export type RepoMaintenancePackReport = {
  /**
   * The pack stopped because its batch was full, not because the backlog was.
   *
   * Stated by the task rather than inferred from a surviving backlog, because
   * those are different things: a task that packs everything and still leaves a
   * backlog behind has failed, and re-arming it would be an unbounded retry of
   * something that is not working. Only a task that says it deliberately left
   * work behind is owed another turn.
   */
  batchExhausted: boolean
}

/** What the host is doing right now, split by what each kind of maintenance must yield to. */
export type RepoMaintenanceActivity = {
  /** The user or an agent is working with repositories, so ref work must wait. */
  interactive: boolean
  /** The machine cannot spare the work at all: shutdown, battery, or a saturated CPU. */
  constrained: boolean
}

/**
 * When a task may run. `idle` waits for the user and every agent to go quiet,
 * because it takes a lock that ref work needs. `unconstrained` takes no lock
 * anything waits on, so it yields only to the machine itself -- otherwise a user
 * who always has an agent running would never get it at all.
 */
export type RepoMaintenanceWindow = 'idle' | 'unconstrained'

/**
 * One unit of maintenance on the shared schedule.
 *
 * The scheduler knows only "probe, compare to threshold, pack, re-probe"; what a
 * backlog is and how it is paid down belongs entirely to the task, so adding a
 * third kind of maintenance never touches the scheduler.
 */
export type RepoMaintenanceTask = {
  readonly id: RepoMaintenanceTaskId
  /** Below this the backlog is cheaper to carry than to pack. */
  readonly threshold: number
  /** Absent means `idle`: a task has to say it is safe beside live work. */
  readonly window?: RepoMaintenanceWindow
  /**
   * Bounded backlog count. `undefined` means the repository could not be
   * resolved on this host -- which is not the same as clean, and never packs.
   */
  probeBacklog(budget: number, signal: AbortSignal): Promise<RepoMaintenanceBacklog | undefined>
  /**
   * Pay down at most one batch of the backlog, to completion.
   *
   * Deliberately takes no abort signal: killing a pack is measurably worse than
   * waiting for it (see `PACKED_REFS_LOCK_*`), and a batch is bounded so the
   * wait is bounded too. A task that takes `packed-refs.lock` must report its
   * transitions through `lock` so callers can wait out the window that actually
   * blocks them; a task that takes no such lock leaves `lock` alone.
   */
  pack(lock: PackedRefsLockReporter): Promise<RepoMaintenancePackReport>
}

export type RepoMaintenanceTarget = {
  /** Repo identity scoped to its execution host; all state here is keyed by it. */
  readonly key: string
  /** Run in this order within one attempt. */
  readonly tasks: readonly RepoMaintenanceTask[]
  /** A user who told Git not to auto-maintain this repo has told Orca too. */
  isOptedOut?(signal: AbortSignal): Promise<boolean>
  /** True while work on *this repo* is in flight -- a fetch, a create, a removal. */
  isBusy?(): boolean
}

/** How a task tells the scheduler whether the exclusive write window is open. */
export type PackedRefsLockReporter = {
  setHeld(held: boolean): void
}

export type RepoMaintenanceOptions = {
  now?: () => number
  /** App-wide activity; absent means nothing is going on. */
  activity?: () => RepoMaintenanceActivity
  /** Wraps one attempt so a host can trace it; must invoke and await `attempt`. */
  observe?: (attempt: (span: RepoMaintenanceSpan) => Promise<void>) => Promise<void>
  quietPeriodMs?: number
  remainderDelayMs?: number
  onError?: (error: unknown) => void
}

/** Marks an abort Orca asked for, so the attempt is retried rather than blamed on the repo. */
export class RepoMaintenanceInterrupted extends Error {
  constructor(
    reason: string,
    /** True when the attempt ran out of time rather than yielding to real work. */
    readonly deadline = false
  ) {
    super(`Repo maintenance interrupted: ${reason}`)
    this.name = 'RepoMaintenanceInterrupted'
  }
}

/**
 * The repository's `packed-refs.lock` is held by something we must not touch.
 * Distinct from a failure so a strand our own dead process left can be retried
 * once it ages into reclaimability, rather than parked for six hours.
 */
export class RepoMaintenanceRepoLocked extends Error {
  constructor(detail: string) {
    super(`packed-refs.lock is held: ${detail}`)
    this.name = 'RepoMaintenanceRepoLocked'
  }
}
