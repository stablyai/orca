import type { AutomationRun, AutomationRunsPage } from './automations-types'

const MAX_PAGE_SIZE = 100

/** A keyset boundary (`createdAt:id` of the previous page's last run), or the
 *  bare offset older hosts emitted — still read so a cursor issued before an
 *  upgrade keeps working. */
type AutomationRunCursor =
  | { kind: 'key'; createdAt: number; id: string }
  | { kind: 'offset'; offset: number }

function decodeAutomationRunCursor(cursor: string | undefined): AutomationRunCursor | null {
  if (!cursor) {
    return null
  }
  const separator = cursor.indexOf(':')
  if (separator === -1) {
    const offset = Number.parseInt(cursor, 10)
    return Number.isFinite(offset) && offset > 0 ? { kind: 'offset', offset } : null
  }
  const createdAt = Number.parseInt(cursor.slice(0, separator), 10)
  const id = cursor.slice(separator + 1)
  return Number.isFinite(createdAt) && id ? { kind: 'key', createdAt, id } : null
}

/** The single total order pages and cursors agree on. Ties on `createdAt` fall
 *  back to `id`, so a pruned boundary cannot take the runs tied with it. */
export function compareAutomationRunsNewestFirst(
  left: Pick<AutomationRun, 'createdAt' | 'id'>,
  right: Pick<AutomationRun, 'createdAt' | 'id'>
): number {
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id)
}

function pageStartIndex(
  runs: readonly AutomationRun[],
  cursor: AutomationRunCursor | null
): number {
  if (!cursor) {
    return 0
  }
  if (cursor.kind === 'offset') {
    return Math.min(cursor.offset, runs.length)
  }
  const boundary = runs.findIndex(
    (run) => run.id === cursor.id && run.createdAt === cursor.createdAt
  )
  if (boundary !== -1) {
    return boundary + 1
  }
  // Boundary run pruned between pages: resume at the first run the total order
  // places after it, so runs tied on `createdAt` are not dropped with it.
  const older = runs.findIndex((run) => compareAutomationRunsNewestFirst(cursor, run) < 0)
  return older === -1 ? runs.length : older
}

/**
 * Pages `runs`, which must already be sorted by `compareAutomationRunsNewestFirst`.
 * The cursor names the previous page's last run rather than an index, so runs
 * created between two page requests cannot shift the window and drop a run.
 */
export function paginateAutomationRuns(
  runs: readonly AutomationRun[],
  limit?: number,
  cursor?: string
): AutomationRunsPage {
  const start = pageStartIndex(runs, decodeAutomationRunCursor(cursor))
  const boundedLimit = Math.min(Math.max(1, limit ?? 100), MAX_PAGE_SIZE)
  const page = runs.slice(start, start + boundedLimit)
  const last = page.at(-1)
  return {
    runs: page,
    nextCursor: last && start + page.length < runs.length ? `${last.createdAt}:${last.id}` : null
  }
}
