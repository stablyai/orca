/** Fence Git-status line-stat writes independently of snapshot storage. */
export type GitStatusLineStatsWriteToken = {
  cacheKey: string
  globalGeneration: number
  keyGeneration: number
  beginSeq: number
}

const GIT_STATUS_LINE_STATS_WRITE_KEYS_MAX_ENTRIES = 1024

// Capture invalidation generations at scan start; mismatches prevent publishing pre-mutation stats.
let globalInvalidationGeneration = 0
const keyInvalidationGenerationByWorktree = new Map<string, number>()
// Latest-begun recompute wins; reuse-only readers that never store must not starve older writes.
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
