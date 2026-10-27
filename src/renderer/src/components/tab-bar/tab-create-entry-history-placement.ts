// Place history with matching URL entries, otherwise below file matches and above creation/search fallbacks.

import { dropUrlEntriesCoveredByHistoryRows } from './open-tab-entry-dedupe'
import {
  isActiveEntryOption,
  type ActiveEntryOption,
  type ActiveOption,
  type BrowserHistoryOmniboxRow
} from './tab-create-entry-active-option'
import type { TabEntryOption } from './tab-create-entry-action'

function isTypedUrlOption(option: TabEntryOption): boolean {
  const { kind } = option.classification
  return kind === 'explicit-url' || kind === 'host-url'
}

// Prefer workspace files over navigating away to remembered pages, including fuzzy file matches.
function isFileOption(option: TabEntryOption): boolean {
  const { kind } = option.classification
  return kind === 'existing-file' || kind === 'absolute-file' || kind === 'html-file-url'
}

function historyInsertIndex(
  options: readonly ActiveEntryOption[],
  keptOptions: readonly ActiveEntryOption[]
): number {
  // Reuse typed-URL placement so browsing history cannot change Enter’s destination ranking.
  const urlIndex = options.findIndex(isTypedUrlOption)
  if (urlIndex !== -1) {
    return keptOptions.includes(options[urlIndex]) ? urlIndex + 1 : urlIndex
  }
  // Find the last file match because phrase queries can interleave web search before fuzzy files.
  let insertAt = 0
  for (const [index, option] of keptOptions.entries()) {
    if (isFileOption(option)) {
      insertAt = index + 1
    }
  }
  return insertAt
}

export function placeHistoryRowsInEntryOptions(
  entryOptions: readonly TabEntryOption[],
  historyRows: readonly BrowserHistoryOmniboxRow[]
): readonly ActiveOption[] {
  const options = entryOptions.filter(isActiveEntryOption)
  const keptOptions = dropUrlEntriesCoveredByHistoryRows(options, historyRows)
  const rows = keptOptions.map((option) => ({ kind: 'entry' as const, option }))
  if (historyRows.length === 0) {
    return rows
  }
  const insertAt = historyInsertIndex(options, keptOptions)
  return [
    ...rows.slice(0, insertAt),
    ...historyRows.map((option) => ({ kind: 'history' as const, option })),
    ...rows.slice(insertAt)
  ]
}
