import type { ClassifiedError } from '../../../../shared/classified-error'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

/** Inclusive updatedAt cursors preserve timestamp ties; dedup boundary rows and backfill full display pages, flushing partials on exhaustion/stall. */

// IDs repeat across repos; dedup by repo plus item ID.
export function workItemIdentity(item: Pick<GitHubWorkItem, 'id' | 'repoId'>): string {
  return `${item.repoId}:${item.id}`
}

export type EmptyPageOutcome = {
  reason: 'window-unreachable' | 'load-failed' | 'end-of-data'
  /** Count clamp or null; window limits belong in applyWindowPageLimit, never the count slot. */
  clampTotalPagesTo: number | null
}

/** Only all-window 422 errors prove a cap; transient sibling failures win, and clean-empty results may withdraw speculative counts only. */
export function resolveEmptyPageOutcome(args: {
  target: number
  failedCount: number
  errorTypes: readonly ClassifiedError['type'][]
  countedTotalPages: number | null
}): EmptyPageOutcome {
  const clamp = Math.max(1, Math.floor(args.target))
  // A sibling non-window error may hide healthy pages, so it must block the clamp.
  const onlyWindowErrors =
    args.errorTypes.length > 0 && args.errorTypes.every((type) => type === 'validation_error')
  if (onlyWindowErrors && args.failedCount === 0) {
    return { reason: 'window-unreachable', clampTotalPagesTo: clamp }
  }
  if (args.failedCount > 0 || args.errorTypes.length > 0) {
    return { reason: 'load-failed', clampTotalPagesTo: null }
  }
  const countUnknown = args.countedTotalPages === null || args.countedTotalPages === 0
  return { reason: 'end-of-data', clampTotalPagesTo: countUnknown ? clamp : null }
}

/** Clamp speculative counts against the latest committed state; store proven 422 limits separately so late real counts can replace speculation. */
export function applyEmptyPageClamp(
  previous: number | null,
  args: {
    target: number
    failedCount: number
    errorTypes: readonly ClassifiedError['type'][]
  }
): number | null {
  const outcome = resolveEmptyPageOutcome({ ...args, countedTotalPages: previous })
  if (outcome.reason !== 'end-of-data' || outcome.clampTotalPagesTo === null) {
    return previous
  }
  return outcome.clampTotalPagesTo
}

/** Proven window 422 limit: set once, only ever lowered, reset per generation. */
export function applyWindowPageLimit(previous: number | null, target: number): number {
  const clamp = Math.max(1, Math.floor(target))
  return previous === null ? clamp : Math.min(previous, clamp)
}

/** Cap count/fallback by the proven window limit, retaining loaded pages; separate state makes late count updates order-independent. */
export function deriveAdvertisedTotalPages(args: {
  loadedPages: number
  countedTotalPages: number | null
  fallbackTotalPages: number
  provenPageLimit: number | null
}): number {
  const uncapped =
    args.countedTotalPages && args.countedTotalPages > 0
      ? Math.max(args.loadedPages, args.countedTotalPages)
      : args.fallbackTotalPages
  const capped = args.provenPageLimit === null ? uncapped : Math.min(uncapped, args.provenPageLimit)
  return Math.max(args.loadedPages, capped)
}

/** Key selection by request fields and resolved timestamp-free source context so fresh repo arrays cannot reset pagination mid-click. */
export function buildSelectedReposKey<
  T extends {
    id: string
    path: string
    connectionId?: string | null
    executionHostId?: string | null
  }
>(repos: readonly T[], sourceContextFor: (repo: T) => unknown): string {
  return repos
    .map(
      (r) =>
        `${r.id}|${r.path}|${r.connectionId ?? ''}|${r.executionHostId ?? ''}|${JSON.stringify(
          sourceContextFor(r)
        )}`
    )
    .join(',')
}

export type WorkItemPageFetchResult = { items: GitHubWorkItem[] }

export type AccumulateWorkItemPagesArgs = {
  existingPages: readonly GitHubWorkItem[][]
  /** updatedAt of the oldest currently-loaded row — the first fetch cursor. */
  initialCursor: string
  /** 0-indexed page the user is trying to reach. */
  targetPage: number
  pageSize: number
  /** Fetch one page for the given inclusive cursor. */
  fetchPage: (cursor: string) => Promise<WorkItemPageFetchResult>
  isCancelled: () => boolean
}

export type AccumulateWorkItemPagesResult =
  | { cancelled: true }
  | {
      cancelled: false
      newPages: GitHubWorkItem[][]
      loadedPages: number
    }

/** Backfill boundary-deduped rows into full display pages until the target or source exhaustion/stall. */
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
    // Advance from raw rows; stop when no fresh identities remain to avoid looping over oversized timestamp ties.
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

  // Flush partial rows after exhaustion/stall so the tail stays reachable.
  if (buffer.length > 0 && loadedPages <= targetPage) {
    newPages.push(buffer)
    loadedPages += 1
  }

  return { cancelled: false, newPages, loadedPages }
}
