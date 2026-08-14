import type { GitHistoryCursor, GitHistoryResult } from '../../../../shared/git-history'

/**
 * Fold a newly fetched page onto the commits already on screen.
 *
 * Only a page that continued the cursor we sent may be appended. A refresh carries no cursor, and a
 * cursor the host could not honor — dead anchor, or a walk that drifted under it — is answered with
 * a fresh page from HEAD; stacking either under the accumulated list would show a new history below
 * a dead one. Both replace instead, which is why the whole decision lives here, not at the call site.
 *
 * Page metadata (refs, merge base, incoming/outgoing, the next cursor) describes the branch and the
 * paging position rather than the page's contents, so the newest page wins.
 */
export function foldGitHistoryPage(
  previous: GitHistoryResult | undefined,
  page: GitHistoryResult,
  requestedCursor: GitHistoryCursor | undefined
): GitHistoryResult {
  const continued = Boolean(requestedCursor && page.continuedCursor)
  if (!previous || !continued) {
    return page
  }

  // Why: ids are immutable, so dropping repeats keeps React keys unique if HEAD moved under the
  // walk between pages and shifted the offset.
  const seen = new Set(previous.items.map((item) => item.id))
  const added = page.items.filter((item) => !seen.has(item.id))

  if (added.length === 0) {
    // Why: a page that adds nothing cannot page any further — a host that ignores the cursor hands
    // back page one forever. Stop rather than leave a "Load more" button that never moves.
    return { ...page, items: previous.items, hasMore: false, nextCursor: undefined }
  }

  return { ...page, items: [...previous.items, ...added] }
}
