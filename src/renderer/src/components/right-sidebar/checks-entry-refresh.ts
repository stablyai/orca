// Why: extracted as a pure helper so the freshness decision is unit-testable
// without mounting ChecksPanel and its many store dependencies. The rules come
// from docs/refresh-on-checks-tab.md (Grace window + Edge cases sections).

export const ENTRY_REFRESH_GRACE_MS = 15_000

export type EntryRefreshInput = {
  prFetchedAt: number | undefined
  checksFetchedAt: number | undefined
  commentsFetchedAt: number | undefined
  prNumber: number | null
  now: number
  graceMs?: number
}

/**
 * Decide whether entering the Checks tab should trigger a force refresh.
 *
 * Rules:
 * - Missing PR cache timestamp is stale (cold start, never fetched).
 * - A cached PR timestamp older than `now - graceMs` is stale; this also
 *   covers cached `null` PR results, which still have a fetchedAt.
 * - When a PR number is known, missing checks/comments timestamps are stale
 *   (their caches are not persisted, so they restart empty).
 * - When no PR number is known, checks/comments timestamps are not relevant.
 */
export function shouldEntryRefresh(input: EntryRefreshInput): boolean {
  const { prFetchedAt, checksFetchedAt, commentsFetchedAt, prNumber, now } = input
  const graceMs = input.graceMs ?? ENTRY_REFRESH_GRACE_MS
  const cutoff = now - graceMs

  if (prFetchedAt === undefined || prFetchedAt < cutoff) {
    return true
  }

  if (prNumber !== null) {
    if (checksFetchedAt === undefined || checksFetchedAt < cutoff) {
      return true
    }
    if (commentsFetchedAt === undefined || commentsFetchedAt < cutoff) {
      return true
    }
  }

  return false
}
