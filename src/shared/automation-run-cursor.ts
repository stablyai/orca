import type { AutomationRun, AutomationRunsPage } from './automations-types'

const MAX_PAGE_SIZE = 100

/** Read keyset createdAt:id boundaries and legacy offsets so pre-upgrade cursors remain usable. */
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

/** Order by createdAt then id so pruning a boundary cannot hide tied runs. */
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
  // Resume after pruned keyset boundaries without dropping createdAt ties.
  const older = runs.findIndex((run) => compareAutomationRunsNewestFirst(cursor, run) < 0)
  return older === -1 ? runs.length : older
}

/** Require newest-first sorted runs; keyset boundaries prevent inter-page inserts shifting offsets and skipping runs. */
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
