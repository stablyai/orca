import { settleGitBranchLineTotalWithinSoftDeadline } from './git-branch-line-total'
import {
  beginGitStatusLineStatsCacheWrite,
  bumpGitStatusLineStatsKeyGeneration,
  isWriteTokenCurrent,
  markGitStatusLineStatsStored,
  resetGitStatusLineStatsWriteGenerations,
  type GitStatusLineStatsWriteToken
} from './git-status-line-stats-write-token'
import type { GitBranchLineTotal, GitStatusResult } from './git-status-types'
import {
  createGitStatusLineStatsSnapshot,
  createInputIdentity,
  type CachedLineStats,
  type GitStatusLineStatsEntry
} from './git-status-line-stats-snapshot'

export {
  beginGitStatusLineStatsCacheWrite,
  type GitStatusLineStatsWriteToken
} from './git-status-line-stats-write-token'

type BranchLineTotalResult = Pick<GitStatusResult, 'branchLineTotal' | 'branchLineTotalUnavailable'>

function branchLineTotalResult(
  total: GitBranchLineTotal | null | undefined,
  mergeBase: string
): BranchLineTotalResult {
  if (total === null) {
    return { branchLineTotalUnavailable: mergeBase }
  }
  return total === undefined ? {} : { branchLineTotal: total }
}

// Why: the TTL is the sole staleness backstop when file contents change while
// the porcelain identity stays "modified" (added/removed are excluded from the
// reuse identity), so a missed watcher signal pins counts for at most this long.
export const GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS = 2 * 60_000
const GIT_STATUS_LINE_STATS_CACHE_MAX_ENTRIES = 128
const lineStatsByWorktree = new Map<string, CachedLineStats>()

// Why: wall-clock steps (NTP, VM resume) must not extend or shrink the TTL.
const monotonicNowMs = (): number => performance.now()

function trimLineStatsCache(now: number): void {
  for (const [key, cached] of lineStatsByWorktree) {
    if (now - cached.storedAt >= GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS) {
      lineStatsByWorktree.delete(key)
    }
  }
  while (lineStatsByWorktree.size > GIT_STATUS_LINE_STATS_CACHE_MAX_ENTRIES) {
    const oldestKey = lineStatsByWorktree.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    lineStatsByWorktree.delete(oldestKey)
  }
}

export function applyCachedGitStatusLineStats(input: {
  cacheKey: string
  head?: string
  entries: GitStatusLineStatsEntry[]
  now?: number
}): boolean {
  const now = input.now ?? monotonicNowMs()
  const cached = lineStatsByWorktree.get(input.cacheKey)
  if (!cached) {
    return false
  }
  if (
    now - cached.storedAt >= GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS ||
    cached.identity !== createInputIdentity(input.head, input.entries)
  ) {
    lineStatsByWorktree.delete(input.cacheKey)
    return false
  }

  lineStatsByWorktree.delete(input.cacheKey)
  lineStatsByWorktree.set(input.cacheKey, cached)
  input.entries.forEach((entry, index) => {
    const stats = cached.stats[index]
    if (stats?.added !== undefined) {
      entry.added = stats.added
    }
    if (stats?.removed !== undefined) {
      entry.removed = stats.removed
    }
  })
  return true
}

/**
 * Only valid immediately after `applyCachedGitStatusLineStats` returned true —
 * that call is what proves the snapshot is fresh and matches this scan's
 * entries. The merge base must match too, or the total describes a fork point
 * this scan is no longer comparing against.
 */
export function readCachedGitBranchLineTotal(input: {
  cacheKey: string
  mergeBase: string
}): GitBranchLineTotal | null | undefined {
  const cached = lineStatsByWorktree.get(input.cacheKey)
  if (cached?.branchLineTotalUnavailable === input.mergeBase) {
    return null
  }
  const total = cached?.branchLineTotal
  return total?.mergeBase === input.mergeBase ? total : undefined
}

/**
 * Backfills an exact total or explicit unavailability onto a matching snapshot.
 * Unlike a full store it must not retire older in-flight entry-stat scans.
 */
export function updateCachedGitBranchLineTotal(input: {
  cacheKey: string
  head?: string
  entries: GitStatusLineStatsEntry[]
  mergeBase: string
  branchLineTotal: GitBranchLineTotal | null
  writeToken: GitStatusLineStatsWriteToken
}): void {
  if (!isWriteTokenCurrent(input.writeToken)) {
    return
  }
  const cached = lineStatsByWorktree.get(input.cacheKey)
  if (
    !cached ||
    cached.identity !== createInputIdentity(input.head, input.entries) ||
    input.writeToken.beginSeq < (cached.branchLineTotalWriteSeq ?? 0)
  ) {
    return
  }
  if (input.branchLineTotal === null) {
    if (cached.branchLineTotal?.mergeBase === input.mergeBase) {
      delete cached.branchLineTotal
    }
    cached.branchLineTotalUnavailable = input.mergeBase
  } else {
    cached.branchLineTotal = input.branchLineTotal
    if (cached.branchLineTotalUnavailable === input.branchLineTotal.mergeBase) {
      delete cached.branchLineTotalUnavailable
    }
  }
  cached.branchLineTotalWriteSeq = input.writeToken.beginSeq
}

export function storeGitStatusLineStats(input: {
  cacheKey: string
  head?: string
  entries: GitStatusLineStatsEntry[]
  now?: number
  writeToken?: GitStatusLineStatsWriteToken
  branchLineTotal?: GitBranchLineTotal
  branchLineTotalUnavailable?: string
}): void {
  const writeToken = input.writeToken ?? beginGitStatusLineStatsCacheWrite(input.cacheKey)
  if (!isWriteTokenCurrent(writeToken)) {
    return
  }
  markGitStatusLineStatsStored(input.cacheKey, writeToken.beginSeq)
  const now = input.now ?? monotonicNowMs()
  const snapshot = createGitStatusLineStatsSnapshot(
    input,
    lineStatsByWorktree.get(input.cacheKey),
    writeToken.beginSeq,
    now
  )
  lineStatsByWorktree.delete(input.cacheKey)
  lineStatsByWorktree.set(input.cacheKey, snapshot)
  trimLineStatsCache(now)
}

/**
 * Shared post-status line-stat step for every host that executes Git. Reuses
 * the cached snapshot only for hinted safety reads; otherwise recomputes and
 * stores. `recompute` returns false when the counts are incomplete (e.g. a
 * transient numstat failure) so a failed pass never replaces or pins a
 * snapshot, and the previous good counts stay reusable.
 */
function createGitStatusLineStatsAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

export async function reuseOrRecomputeGitStatusLineStats(input: {
  cacheKey: string
  head?: string
  entries: GitStatusLineStatsEntry[]
  writeToken: GitStatusLineStatsWriteToken
  reuse: boolean
  isAborted: () => boolean
  recompute: () => Promise<boolean>
  /** Omitted when the caller did not ask for a branch total, which costs nothing. */
  branchLineTotal?: {
    mergeBase: string
    compute: () => Promise<GitBranchLineTotal | null | undefined>
  }
}): Promise<BranchLineTotalResult> {
  if (input.isAborted()) {
    // Why: reject rather than resolve — a cancelled scan must not look like a
    // completed status result (including a cache-hit reuse path).
    throw createGitStatusLineStatsAbortError()
  }
  if (
    input.reuse &&
    applyCachedGitStatusLineStats({
      cacheKey: input.cacheKey,
      head: input.head,
      entries: input.entries
    })
  ) {
    if (input.isAborted()) {
      throw createGitStatusLineStatsAbortError()
    }
    return reuseCachedBranchLineTotal(input)
  }
  // Why: started before the await below so both diffs run concurrently, and
  // pre-caught so an aborted total can never surface as an unhandled rejection
  // when recompute rejects first.
  const totalPromise = input.branchLineTotal?.compute().catch(() => undefined)
  const complete = await input.recompute()
  const branchLineTotal = totalPromise
    ? await settleGitBranchLineTotalWithinSoftDeadline({
        total: totalPromise,
        onLateArrival: (late) => {
          if (!input.isAborted() && input.branchLineTotal) {
            updateCachedGitBranchLineTotal({
              cacheKey: input.cacheKey,
              head: input.head,
              entries: input.entries,
              mergeBase: input.branchLineTotal.mergeBase,
              branchLineTotal: late,
              writeToken: input.writeToken
            })
          }
        }
      })
    : undefined
  if (input.isAborted()) {
    // Why: an aborted pass never reached storeGitStatusLineStats, so there is
    // nothing partial to undo; clearing here would instead evict a concurrent
    // scan's healthy snapshot and force a redundant numstat on the next read.
    // Reject so the caller cannot treat this pass as a successful status.
    throw createGitStatusLineStatsAbortError()
  }
  const result = input.branchLineTotal
    ? branchLineTotalResult(branchLineTotal, input.branchLineTotal.mergeBase)
    : {}
  if (!complete) {
    // The independent ranged diff can invalidate an older exact total even if
    // this pass's per-area stats are incomplete and must not replace the cache.
    if (branchLineTotal === null && input.branchLineTotal) {
      updateCachedGitBranchLineTotal({
        cacheKey: input.cacheKey,
        head: input.head,
        entries: input.entries,
        mergeBase: input.branchLineTotal.mergeBase,
        branchLineTotal,
        writeToken: input.writeToken
      })
    }
    return result
  }
  storeGitStatusLineStats({
    cacheKey: input.cacheKey,
    head: input.head,
    entries: input.entries,
    writeToken: input.writeToken,
    ...result
  })
  if (!input.branchLineTotal) {
    return {}
  }
  // Why: read back rather than return the local — the store carries forward a
  // total that arrived late on an unchanged snapshot, which is the only way the
  // chip ever appears where the diff always outruns the soft deadline.
  const published = readCachedGitBranchLineTotal({
    cacheKey: input.cacheKey,
    mergeBase: input.branchLineTotal.mergeBase
  })
  return branchLineTotalResult(published, input.branchLineTotal.mergeBase)
}

async function reuseCachedBranchLineTotal(input: {
  cacheKey: string
  head?: string
  entries: GitStatusLineStatsEntry[]
  writeToken: GitStatusLineStatsWriteToken
  isAborted: () => boolean
  branchLineTotal?: {
    mergeBase: string
    compute: () => Promise<GitBranchLineTotal | null | undefined>
  }
}): Promise<BranchLineTotalResult> {
  if (!input.branchLineTotal) {
    return {}
  }
  const { mergeBase } = input.branchLineTotal
  const cached = readCachedGitBranchLineTotal({ cacheKey: input.cacheKey, mergeBase })
  if (cached !== undefined) {
    return branchLineTotalResult(cached, mergeBase)
  }
  // The snapshot predates this feature or was computed against another fork
  // point; compute once and backfill so the next reuse hit is free. A reuse pass
  // exists to be cheap, so it waits no longer than any other for the diff.
  const backfill = (late: GitBranchLineTotal | null): void => {
    if (input.isAborted()) {
      return
    }
    updateCachedGitBranchLineTotal({
      cacheKey: input.cacheKey,
      head: input.head,
      entries: input.entries,
      mergeBase,
      branchLineTotal: late,
      writeToken: input.writeToken
    })
  }
  const branchLineTotal = await settleGitBranchLineTotalWithinSoftDeadline({
    total: input.branchLineTotal.compute().catch(() => undefined),
    onLateArrival: backfill
  })
  if (input.isAborted()) {
    throw createGitStatusLineStatsAbortError()
  }
  if (branchLineTotal === undefined) {
    return {}
  }
  backfill(branchLineTotal)
  return branchLineTotalResult(branchLineTotal, mergeBase)
}

export function clearGitStatusLineStatsCache(): void {
  lineStatsByWorktree.clear()
  resetGitStatusLineStatsWriteGenerations()
}

export function clearGitStatusLineStatsCacheKey(
  cacheKey: string,
  writeToken?: GitStatusLineStatsWriteToken
): void {
  if (writeToken !== undefined && !isWriteTokenCurrent(writeToken)) {
    return
  }
  if (writeToken === undefined) {
    bumpGitStatusLineStatsKeyGeneration(cacheKey)
  } else {
    // Why: a token-scoped purge must retire scans that began before it, so an
    // older in-flight scan can't store pre-purge counts and repopulate this key.
    markGitStatusLineStatsStored(cacheKey, writeToken.beginSeq)
  }
  lineStatsByWorktree.delete(cacheKey)
}
