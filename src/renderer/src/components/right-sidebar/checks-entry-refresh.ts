// Freshness policy: docs/refresh-on-checks-tab.md (Grace window and Edge cases).

export const ENTRY_REFRESH_GRACE_MS = 15_000

export type EntryRefreshInput = {
  prFetchedAt: number | undefined
  checksFetchedAt: number | undefined
  commentsFetchedAt: number | undefined
  prNumber: number | null
  now: number
  graceMs?: number
}

/** Refresh stale/missing PR results; require checks/comments freshness only when a PR number is known. */
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
