/**
 * Generation bookkeeping that decides whether a git-status line-stats scan may
 * still write. Split from the cache itself so the snapshot store stays readable.
 */
export type GitStatusLineStatsWriteToken = {
  cacheKey: string
  globalGeneration: number
  keyGeneration: number
  beginSeq: number
}

const GIT_STATUS_LINE_STATS_WRITE_KEYS_MAX_ENTRIES = 1024

// Why: mutation invalidation must retire scans that began before it. A scan
// captures these generations at begin; a mismatch at store/clear time means an
// invalidation happened mid-scan and the derived stats may be pre-mutation.
let globalInvalidationGeneration = 0
const keyInvalidationGenerationByWorktree = new Map<string, number>()
// Why: overlapping recomputes must resolve latest-begun-wins without letting a
// reuse-only read (which never stores) starve an older recompute's store.
const lastStoredBeginSeqByWorktree = new Map<string, number>()
let nextBeginSeq = 0

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

export function isWriteTokenCurrent(token: GitStatusLineStatsWriteToken): boolean {
  return (
    token.globalGeneration === globalInvalidationGeneration &&
    token.keyGeneration === (keyInvalidationGenerationByWorktree.get(token.cacheKey) ?? 0) &&
    token.beginSeq >= (lastStoredBeginSeqByWorktree.get(token.cacheKey) ?? 0)
  )
}

export function markGitStatusLineStatsStored(cacheKey: string, beginSeq: number): void {
  bumpBoundedKeyMap(lastStoredBeginSeqByWorktree, cacheKey, beginSeq)
}

export function bumpGitStatusLineStatsKeyGeneration(cacheKey: string): void {
  bumpBoundedKeyMap(
    keyInvalidationGenerationByWorktree,
    cacheKey,
    (keyInvalidationGenerationByWorktree.get(cacheKey) ?? 0) + 1
  )
}

export function resetGitStatusLineStatsWriteGenerations(): void {
  globalInvalidationGeneration += 1
  keyInvalidationGenerationByWorktree.clear()
  lastStoredBeginSeqByWorktree.clear()
}
