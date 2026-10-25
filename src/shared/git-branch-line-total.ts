import { GitStatusReadLeaseOwner } from './git-status-read-lease-owner'
import type { GitBranchLineTotal } from './git-status-types'
import {
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from './git-uncommitted-line-stats'
import { isGeneratedCodePath } from './generated-code-path'
import { isTestCodePath } from './test-code-path'

export type { GitBranchLineTotal }

// Why: a base→worktree diff on a very large branch over SSH is unbounded
// work. A failed diff invalidates the total rather than publishing a partial
// number or blocking the status response indefinitely.
export const GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS = 15_000

// Why: the hard timeout bounds the git process, not the wait. The status
// response carries the file list and staging state, so it must never sit behind
// a ranged diff — past this budget the pass publishes without the total and the
// diff keeps running to backfill the cache for the next pass.
export const GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS = 500

const BRANCH_LINE_TOTAL_PENDING = Symbol('branch-line-total-pending')

/**
 * Resolves with the exact total or known-unavailable null inside the soft budget;
 * otherwise resolves undefined and hands the still-running diff to `onLateArrival`.
 */
export async function settleGitBranchLineTotalWithinSoftDeadline(input: {
  total: Promise<GitBranchLineTotal | null | undefined>
  onLateArrival: (total: GitBranchLineTotal | null) => void
  softDeadlineMs?: number
}): Promise<GitBranchLineTotal | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof BRANCH_LINE_TOTAL_PENDING>((resolve) => {
    timer = setTimeout(
      () => resolve(BRANCH_LINE_TOTAL_PENDING),
      input.softDeadlineMs ?? GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS
    )
    // Why: a pending status timer must not hold the process open at shutdown.
    timer.unref?.()
  })
  const settled = await Promise.race([input.total, deadline])
  clearTimeout(timer)
  if (settled !== BRANCH_LINE_TOTAL_PENDING) {
    return settled
  }
  void input.total.then((late) => {
    if (late !== undefined) {
      input.onLateArrival(late)
    }
  })
  return undefined
}

/**
 * `git diff <base>` with no second rev and no `--cached` compares that
 * commit to the working tree, so committed + staged + unstaged collapse into one
 * correctly-deduplicated result. Summing the per-area status rows instead would
 * double-count any line touched in two areas.
 *
 * `-M` only (not `-M -C`): matches the working-tree numstat the CHANGES rows are
 * built from, and avoids `-C`'s cost on wide diffs. The trailing `--` keeps the
 * OID parsed as a rev even if a path of the same name exists.
 */
export function buildGitBranchLineTotalDiffArgs(mergeBase: string): string[] {
  return [
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.autoRefreshIndex=false',
    'diff',
    '-z',
    '--numstat',
    '-M',
    mergeBase,
    '--'
  ]
}

/**
 * The pinned base reaches the host as untrusted RPC input and is spliced into a
 * git argv. Only an object name shape is ever legitimate here, so anything else
 * (notably a leading `-`) is rejected before it can act as a flag.
 */
export function isGitBranchLineTotalMergeBase(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value)
}

/** Reads the request param without trusting its type; undefined disables the work entirely. */
export function readGitBranchLineTotalMergeBaseParam(value: unknown): string | undefined {
  return isGitBranchLineTotalMergeBase(value) ? value : undefined
}

export function sumGitBranchLineTotal(input: {
  mergeBase: string
  tracked: ReadonlyMap<string, GitLineStats>
  untracked: ReadonlyMap<string, GitLineStats>
}): GitBranchLineTotal {
  let added = 0
  let removed = 0
  let testAdded = 0
  let testRemoved = 0
  let generatedAdded = 0
  let generatedRemoved = 0
  for (const source of [input.tracked, input.untracked]) {
    for (const [filePath, stats] of source) {
      // Binary files parse to undefined in numstat and contribute nothing, matching
      // the per-file rows.
      const fileAdded = stats.added ?? 0
      const fileRemoved = stats.removed ?? 0
      added += fileAdded
      removed += fileRemoved
      // Generated wins the overlap (a snapshot is both): the point of the bucket
      // is to separate authored lines from churn, and a regenerated file is churn
      // wherever it lives.
      if (isGeneratedCodePath(filePath)) {
        generatedAdded += fileAdded
        generatedRemoved += fileRemoved
      } else if (isTestCodePath(filePath)) {
        testAdded += fileAdded
        testRemoved += fileRemoved
      }
    }
  }
  return {
    added,
    removed,
    mergeBase: input.mergeBase,
    test: { added: testAdded, removed: testRemoved },
    generated: { added: generatedAdded, removed: generatedRemoved }
  }
}

// Why: one shared exec per (host, worktree, mergeBase). The renderer's own
// in-flight refs only dedupe a single renderer's calls; a second window or an
// fs-watcher burst would otherwise run the ranged diff twice concurrently.
const rangedNumstatLeaseOwner = new GitStatusReadLeaseOwner<{
  stats: Map<string, GitLineStats>
  renameSources: Set<string>
} | null>()

// Why: the soft deadline hides this diff's cost from the poller's duration-aware
// backoff, so an overrunning one would restart the moment it finished. Make it
// wait out its own measured cost; the cache carry-forward keeps the chip up.
const GIT_BRANCH_LINE_TOTAL_MAX_COOLDOWN_MS = 30_000
const GIT_BRANCH_LINE_TOTAL_COOLDOWN_MAX_KEYS = 256
const rangedNumstatCooldownUntilMs = new Map<string, number>()

const monotonicNowMs = (): number => performance.now()

function isRangedNumstatCoolingDown(leaseKey: string, nowMs: number): boolean {
  const readyAtMs = rangedNumstatCooldownUntilMs.get(leaseKey)
  if (readyAtMs === undefined) {
    return false
  }
  if (nowMs >= readyAtMs) {
    rangedNumstatCooldownUntilMs.delete(leaseKey)
    return false
  }
  return true
}

function recordRangedNumstatDuration(leaseKey: string, durationMs: number, nowMs: number): void {
  if (durationMs <= GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS) {
    rangedNumstatCooldownUntilMs.delete(leaseKey)
    return
  }
  rangedNumstatCooldownUntilMs.delete(leaseKey)
  rangedNumstatCooldownUntilMs.set(
    leaseKey,
    nowMs + Math.min(durationMs, GIT_BRANCH_LINE_TOTAL_MAX_COOLDOWN_MS)
  )
  while (rangedNumstatCooldownUntilMs.size > GIT_BRANCH_LINE_TOTAL_COOLDOWN_MAX_KEYS) {
    const oldestKey = rangedNumstatCooldownUntilMs.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    rangedNumstatCooldownUntilMs.delete(oldestKey)
  }
}

/**
 * Call from every path that clears the other git read caches: without it a pass
 * beginning after a discard/stash/checkout joins the pre-mutation lease.
 */
export function invalidateGitBranchLineTotalInFlight(): void {
  rangedNumstatLeaseOwner.invalidate()
  rangedNumstatCooldownUntilMs.clear()
}

/**
 * Computes the branch total, null when it is known unavailable, or undefined
 * when work was skipped. Rejects only on abort — every other failure
 * invalidates the total instead of publishing a partial number.
 */
export async function computeGitBranchLineTotal(input: {
  worktreePath: string
  /** Spelling for the direct untracked-file reads when the git host's differs; defaults to worktreePath. */
  filesystemWorktreePath?: string
  /** Distinguishes hosts that can map the same path to different filesystems (WSL distro, relay). */
  hostKey: string
  mergeBase: string
  untrackedPaths: readonly string[]
  runDiffNumstat: (args: string[], signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
}): Promise<GitBranchLineTotal | null | undefined> {
  if (!isGitBranchLineTotalMergeBase(input.mergeBase)) {
    return undefined
  }
  const leaseKey = `${input.hostKey}\0${input.worktreePath}\0${input.mergeBase}`
  // Safe before the lease: a cooldown is only armed once a diff settled, so there
  // is never an in-flight one to join while it is active.
  if (isRangedNumstatCoolingDown(leaseKey, monotonicNowMs())) {
    return undefined
  }
  const [tracked, untracked] = await Promise.all([
    rangedNumstatLeaseOwner.lease(leaseKey, input.signal, async (sharedSignal) => {
      const startedAtMs = monotonicNowMs()
      try {
        const stdout = await input.runDiffNumstat(
          buildGitBranchLineTotalDiffArgs(input.mergeBase),
          sharedSignal
        )
        const renameSources = new Set<string>()
        const stats = parseNumstat(stdout, (path) => renameSources.add(path))
        return { stats, renameSources }
      } catch (error) {
        // Why: an aborted pass must reject so a cancelled scan is never treated
        // as completed. Everything else — a bad merge base, a timeout, a
        // detached worktree — yields null to invalidate a previous exact total.
        if (sharedSignal.aborted) {
          throw error
        }
        return null
      } finally {
        // `finally`, not the success path: a timeout is the costliest outcome.
        if (!sharedSignal.aborted) {
          const settledAtMs = monotonicNowMs()
          recordRangedNumstatDuration(leaseKey, settledAtMs - startedAtMs, settledAtMs)
        }
      }
    }),
    // Untracked files are invisible to a ranged diff but already render as
    // CHANGES rows, so they are added on top. Stat-keyed caching inside makes
    // this near-free when attachLineStats just read the same paths.
    collectUntrackedAdditions(
      input.filesystemWorktreePath ?? input.worktreePath,
      input.untrackedPaths,
      input.signal
    )
  ])
  if (tracked === null) {
    return null
  }
  // An untracked copy of a base file needs a content diff; summing would count a deletion plus an addition.
  if (
    input.untrackedPaths.some((path) => tracked.stats.has(path) || tracked.renameSources.has(path))
  ) {
    return null
  }
  return sumGitBranchLineTotal({ mergeBase: input.mergeBase, tracked: tracked.stats, untracked })
}
