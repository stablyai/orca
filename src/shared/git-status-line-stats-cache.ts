type GitStatusLineStatsEntry = {
  path?: unknown
  status?: unknown
  area?: unknown
  oldPath?: unknown
  conflictKind?: unknown
  conflictStatus?: unknown
  conflictStatusSource?: unknown
  submodule?: {
    commitChanged?: boolean
    trackedChanges?: boolean
    untrackedChanges?: boolean
  }
  added?: number
  removed?: number
}

type CachedLineStats = {
  identity: string
  storedAt: number
  stats: { added?: number; removed?: number }[]
}

export type GitStatusLineStatsWriteToken = {
  cacheKey: string
  globalGeneration: number
  keyGeneration: number
  beginSeq: number
}

// Why: the TTL is the sole staleness backstop when file contents change while
// the porcelain identity stays "modified" (added/removed are excluded from the
// reuse identity), so a missed watcher signal pins counts for at most this long.
export const GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS = 2 * 60_000
const GIT_STATUS_LINE_STATS_CACHE_MAX_ENTRIES = 128
const GIT_STATUS_LINE_STATS_WRITE_KEYS_MAX_ENTRIES = 1024
const lineStatsByWorktree = new Map<string, CachedLineStats>()
// Why: mutation invalidation must retire scans that began before it. A scan
// captures these generations at begin; a mismatch at store/clear time means an
// invalidation happened mid-scan and the derived stats may be pre-mutation.
let globalInvalidationGeneration = 0
const keyInvalidationGenerationByWorktree = new Map<string, number>()
// Why: overlapping recomputes must resolve latest-begun-wins without letting a
// reuse-only read (which never stores) starve an older recompute's store.
const lastStoredBeginSeqByWorktree = new Map<string, number>()
let nextBeginSeq = 0

// Why: wall-clock steps (NTP, VM resume) must not extend or shrink the TTL.
const monotonicNowMs = (): number => performance.now()

function bumpBoundedKeyMap(map: Map<string, number>, cacheKey: string, value: number): void {
  map.delete(cacheKey)
  map.set(cacheKey, value)
  while (map.size > GIT_STATUS_LINE_STATS_WRITE_KEYS_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    map.delete(oldestKey)
  }
}

export function beginGitStatusLineStatsCacheWrite(cacheKey: string): GitStatusLineStatsWriteToken {
  return {
    cacheKey,
    globalGeneration: globalInvalidationGeneration,
    keyGeneration: keyInvalidationGenerationByWorktree.get(cacheKey) ?? 0,
    beginSeq: ++nextBeginSeq
  }
}

function isWriteTokenCurrent(token: GitStatusLineStatsWriteToken): boolean {
  return (
    token.globalGeneration === globalInvalidationGeneration &&
    token.keyGeneration === (keyInvalidationGenerationByWorktree.get(token.cacheKey) ?? 0) &&
    token.beginSeq >= (lastStoredBeginSeqByWorktree.get(token.cacheKey) ?? 0)
  )
}

function createInputIdentity(head: string | undefined, entries: GitStatusLineStatsEntry[]): string {
  return JSON.stringify([
    head ?? null,
    entries.map((entry) => [
      entry.path,
      entry.status,
      entry.area,
      entry.oldPath ?? null,
      entry.conflictKind ?? null,
      entry.conflictStatus ?? null,
      entry.conflictStatusSource ?? null,
      entry.submodule?.commitChanged ?? null,
      entry.submodule?.trackedChanges ?? null,
      entry.submodule?.untrackedChanges ?? null
    ])
  ])
}

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

export function storeGitStatusLineStats(input: {
  cacheKey: string
  head?: string
  entries: GitStatusLineStatsEntry[]
  now?: number
  writeToken?: GitStatusLineStatsWriteToken
}): void {
  const writeToken = input.writeToken ?? beginGitStatusLineStatsCacheWrite(input.cacheKey)
  if (!isWriteTokenCurrent(writeToken)) {
    return
  }
  bumpBoundedKeyMap(lastStoredBeginSeqByWorktree, input.cacheKey, writeToken.beginSeq)
  const now = input.now ?? monotonicNowMs()
  lineStatsByWorktree.delete(input.cacheKey)
  lineStatsByWorktree.set(input.cacheKey, {
    identity: createInputIdentity(input.head, input.entries),
    storedAt: now,
    stats: input.entries.map((entry) => ({
      ...(entry.added === undefined ? {} : { added: entry.added }),
      ...(entry.removed === undefined ? {} : { removed: entry.removed })
    }))
  })
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
}): Promise<void> {
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
    return
  }
  const complete = await input.recompute()
  if (input.isAborted()) {
    // Why: an aborted pass never reached storeGitStatusLineStats, so there is
    // nothing partial to undo; clearing here would instead evict a concurrent
    // scan's healthy snapshot and force a redundant numstat on the next read.
    // Reject so the caller cannot treat this pass as a successful status.
    throw createGitStatusLineStatsAbortError()
  }
  if (!complete) {
    return
  }
  storeGitStatusLineStats({
    cacheKey: input.cacheKey,
    head: input.head,
    entries: input.entries,
    writeToken: input.writeToken
  })
}

export function clearGitStatusLineStatsCache(): void {
  globalInvalidationGeneration += 1
  lineStatsByWorktree.clear()
  keyInvalidationGenerationByWorktree.clear()
  lastStoredBeginSeqByWorktree.clear()
}

export function clearGitStatusLineStatsCacheKey(
  cacheKey: string,
  writeToken?: GitStatusLineStatsWriteToken
): void {
  if (writeToken !== undefined && !isWriteTokenCurrent(writeToken)) {
    return
  }
  if (writeToken === undefined) {
    bumpBoundedKeyMap(
      keyInvalidationGenerationByWorktree,
      cacheKey,
      (keyInvalidationGenerationByWorktree.get(cacheKey) ?? 0) + 1
    )
  } else {
    // Why: a token-scoped purge must retire scans that began before it, so an
    // older in-flight scan can't store pre-purge counts and repopulate this key.
    bumpBoundedKeyMap(lastStoredBeginSeqByWorktree, cacheKey, writeToken.beginSeq)
  }
  lineStatsByWorktree.delete(cacheKey)
}
