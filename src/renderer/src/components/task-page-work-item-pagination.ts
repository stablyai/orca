import type { GitHubWorkItem } from '../../../shared/types'

/**
 * Cross-repo Tasks pagination is cursor-based on `updatedAt`: each page's oldest
 * row seeds the next fetch as `updated:<=<cursor>`. The bound is inclusive so
 * items sharing the boundary row's exact timestamp aren't skipped between pages
 * (#8649) — which means the boundary rows come back on the next fetch and must
 * be deduped by identity here.
 *
 * Because dedup removes the re-fetched overlap, a single fetch no longer yields
 * a full page. If we emitted each deduped fetch as its own page, pages 1+ would
 * be one row short of `pageSize` while `totalPages` (count ÷ pageSize) still
 * assumed full pages — stranding the tail items. So we backfill: accumulate
 * fresh rows across as many fetches as needed and emit uniform `pageSize` pages,
 * flushing a short final page only when the source is exhausted.
 *
 * Kept as a pure function (out of the TaskPage component) so the dedup +
 * cursor-advance + fixed-page contract is unit-testable without a DOM.
 *
 * Tradeoff: when the per-repo fetch size equals `pageSize` the boundary dedup
 * costs one extra fetch per page (and re-fetches the sub-page leftover on the
 * next advance). Acceptable for interactive pagination and bounded by the gh
 * rate-limit guard; persisting the cursor/buffer across calls to avoid the
 * re-fetch is a possible follow-up.
 */

// Why: `item.id` (e.g. "issue:9") is only unique within a repo — two selected
// repos can carry the same bare id. Key dedup on repo + id, matching the row
// key the table renders with.
export function workItemIdentity(item: Pick<GitHubWorkItem, 'id' | 'repoId'>): string {
  return `${item.repoId}:${item.id}`
}

export function taskPageToGitHubApiPage(taskPage: number): number {
  return Math.max(0, Math.floor(taskPage)) + 1
}

// Why: provider pages cannot spill truncated rows into the next page. Divide
// the display budget up front so every fetched row remains reachable.
export function getTaskPagePerRepoLimit(
  repoCount: number,
  maxPerRepo: number,
  displayLimit: number
): number {
  const normalizedRepoCount = Math.max(1, Math.floor(repoCount))
  return Math.max(1, Math.min(maxPerRepo, Math.floor(displayLimit / normalizedRepoCount)))
}

export type WorkItemPageFetchResult = { items: GitHubWorkItem[] }

export type AccumulateWorkItemPagesArgs = {
  /** Pages already on screen; their items seed the dedup set. */
  existingPages: readonly GitHubWorkItem[][]
  /** updatedAt of the oldest currently-loaded row — the first fetch cursor. */
  initialCursor: string
  /** 0-indexed page the user is trying to reach. */
  targetPage: number
  /** Uniform display page size (the component's effectivePageSize). */
  pageSize: number
  /** Fetch one page for the given inclusive cursor. */
  fetchPage: (cursor: string) => Promise<WorkItemPageFetchResult>
  /** Returns true if the request was superseded and results should be dropped. */
  isCancelled: () => boolean
}

export type AccumulateWorkItemPagesResult =
  | { cancelled: true }
  | {
      cancelled: false
      /** Freshly fetched, deduped, uniform-sized pages to append. */
      newPages: GitHubWorkItem[][]
      /** Total loaded page count after appending (existing + new). */
      loadedPages: number
    }

/**
 * Fetch pages until `targetPage` is reached (or the source is exhausted),
 * deduping re-fetched boundary rows and emitting uniform `pageSize` pages so
 * every item lands on exactly one page and page sizes stay consistent with the
 * count-derived `totalPages`.
 */
export async function accumulateWorkItemPages(
  args: AccumulateWorkItemPagesArgs
): Promise<AccumulateWorkItemPagesResult> {
  const { existingPages, initialCursor, targetPage, pageSize, fetchPage, isCancelled } = args

  const seen = new Set<string>()
  for (const page of existingPages) {
    for (const item of page) {
      seen.add(workItemIdentity(item))
    }
  }

  let cursor = initialCursor
  let loadedPages = existingPages.length
  const newPages: GitHubWorkItem[][] = []
  // Fresh rows not yet emitted as a page, held until they fill `pageSize`.
  let buffer: GitHubWorkItem[] = []

  const emitFullPages = (): void => {
    while (buffer.length >= pageSize && loadedPages <= targetPage) {
      newPages.push(buffer.slice(0, pageSize))
      buffer = buffer.slice(pageSize)
      loadedPages += 1
    }
  }

  while (loadedPages <= targetPage) {
    const { items } = await fetchPage(cursor)
    if (isCancelled()) {
      return { cancelled: true }
    }
    if (items.length === 0) {
      break
    }
    const fresh = items.filter((item) => !seen.has(workItemIdentity(item)))
    // Advance from the raw fetch, not the deduped rows, so the cursor tracks
    // real data. If a full page yields nothing new the cursor can't move past
    // this timestamp (a rare >pageSize same-timestamp run), so stop rather than
    // re-fetch the same window forever.
    cursor = items.at(-1)!.updatedAt
    if (fresh.length === 0) {
      break
    }
    for (const item of fresh) {
      seen.add(workItemIdentity(item))
    }
    buffer.push(...fresh)
    emitFullPages()
  }

  // Source exhausted (or stalled) with a partial page still buffered: emit it as
  // a short final page so those items remain reachable.
  if (buffer.length > 0 && loadedPages <= targetPage) {
    newPages.push(buffer)
    loadedPages += 1
  }

  return { cancelled: false, newPages, loadedPages }
}
