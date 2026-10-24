import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import type { WorkspaceDocHistoryEntry } from '../../../../../shared/workspace-doc-history'
import { startOfLocalDay } from '../../../../../shared/automation-cron-occurrence'
import {
  listBrowserHistoryRecents,
  type BrowserAddressBarSuggestion
} from '../assemble-chrome/browser-address-bar-suggestions'

export type BrowserHistoryClearRange = 'hour' | 'today' | 'all'

export type BrowserHistoryDay = {
  /** Local midnight of the day, which also orders the groups. */
  startsAt: number
  rows: BrowserAddressBarSuggestion[]
}

/** The cmdk value for a row: unique across pages and documents. */
export function browserHistoryRowKey(row: BrowserAddressBarSuggestion): string {
  return row.docLocation
    ? `doc:${row.docLocation.worktreeId}:${row.docLocation.filePath}`
    : `url:${row.normalizedUrl ?? row.url}`
}

/**
 * Pages and documents as one list, newest first. Like Chrome's history search, every word must
 * appear in the title or the address, in any order.
 */
export function listBrowserHistoryRows(
  browserUrlHistory: readonly BrowserHistoryEntry[],
  workspaceDocHistory: readonly WorkspaceDocHistoryEntry[],
  query: string
): BrowserAddressBarSuggestion[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return listBrowserHistoryRecents(browserUrlHistory, workspaceDocHistory).filter((row) => {
    const text = `${row.title}\n${row.subtitle}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** Groups rows already sorted newest first by the local day of their last visit. */
export function groupBrowserHistoryRowsByDay(
  rows: readonly BrowserAddressBarSuggestion[]
): BrowserHistoryDay[] {
  const days: BrowserHistoryDay[] = []
  for (const row of rows) {
    const startsAt = startOfLocalDay(row.lastVisitedAt)
    const day = days.at(-1)
    if (day?.startsAt === startsAt) {
      day.rows.push(row)
    } else {
      days.push({ startsAt, rows: [row] })
    }
  }
  return days
}

/** The earliest visit a clear removes; undefined clears everything. */
export function browserHistoryClearSince(
  range: BrowserHistoryClearRange,
  now = Date.now()
): number | undefined {
  if (range === 'hour') {
    return now - 60 * 60 * 1000
  }
  return range === 'today' ? startOfLocalDay(now) : undefined
}
