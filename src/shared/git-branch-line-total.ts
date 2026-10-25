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

// Bound large base-to-worktree diffs over SSH; failures invalidate totals instead of publishing partial values.
export const GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS = 15_000

// Do not hold file/staging status behind the hard process timeout; publish without totals after this budget and backfill later.
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

/** git diff <base> collapses committed/staged/unstaged changes without double-counting lines touched in multiple areas.
 * -M matches CHANGES numstat without -C’s wide-diff cost; trailing -- disambiguates OIDs from paths. */
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

/** Pinned bases are untrusted RPC input; accept only object-name shapes so argv cannot acquire flags. */
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
      // Binary numstat entries contribute no lines, matching per-file rows.
      const fileAdded = stats.added ?? 0
      const fileRemoved = stats.removed ?? 0
      added += fileAdded
      removed += fileRemoved
      // Generated wins overlaps (e.g. test snapshots): regenerated lines are churn wherever stored.
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

// Lease one exec per host/worktree/base across windows and watcher bursts; renderer refs only dedupe one window.
const rangedNumstatLeaseOwner = new GitStatusReadLeaseOwner<{
  stats: Map<string, GitLineStats>
  renameSources: Set<string>
} | null>()

// Soft deadlines hide diff cost from poller backoff; cool down by measured cost to prevent immediate restarts, retaining cached totals.
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

/** Invalidate with other Git read caches so post-discard/stash/checkout passes cannot join pre-mutation leases. */
export function invalidateGitBranchLineTotalInFlight(): void {
  rangedNumstatLeaseOwner.invalidate()
  rangedNumstatCooldownUntilMs.clear()
}

/** Return exact totals, null when unavailable, or undefined when skipped; only abort rejects, while other failures invalidate prior totals. */
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
  // Cooldown starts only after settlement, so no in-flight lease exists to join while cooling.
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
        // Abort must reject, never mark a cancelled scan complete. Other failures return null to invalidate prior exact totals.
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
    // Ranged diffs omit untracked files shown in CHANGES; stat caching makes their addition cheap after attachLineStats.
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
