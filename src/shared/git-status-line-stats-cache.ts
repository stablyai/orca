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

// TTL bounds stale counts after missed watcher signals even if porcelain stays modified; counts are excluded from reuse identity.
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

/** Read only after successful applyCachedGitStatusLineStats proves fresh matching entries; merge base must also match. */
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

/** Backfill an exact total or unavailability on a matching snapshot without retiring older entry-stat scans. */
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

function createGitStatusLineStatsAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** Reuse only for hinted safety reads; otherwise recompute. Incomplete counts must not replace or pin a healthy snapshot. */
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
    // Cancelled scans must reject, including cache hits, rather than appear completed.
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
  // Run both diffs concurrently; pre-catch totals so an earlier recompute rejection cannot leave an unhandled abort.
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
    // Abort stored nothing; clearing would evict a concurrent healthy snapshot. Reject so the pass cannot look successful.
    throw createGitStatusLineStatsAbortError()
  }
  const result = input.branchLineTotal
    ? branchLineTotalResult(branchLineTotal, input.branchLineTotal.mergeBase)
    : {}
  if (!complete) {
    // An independent ranged failure can invalidate totals even when incomplete per-area stats cannot replace the snapshot.
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
  // Read the stored total: unchanged snapshots retain late arrivals, allowing chips when diffs always exceed the soft deadline.
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
  // Older/different-base snapshots need one backfill; reuse reads still respect the soft deadline.
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
    // Token-scoped purges retire older scans so pre-purge counts cannot repopulate the key.
    markGitStatusLineStatsStored(cacheKey, writeToken.beginSeq)
  }
  lineStatsByWorktree.delete(cacheKey)
}
