// Where the browser-history block lands inside the omnibox entry rows: below
// every file the query matched and below anything the user typed as a URL,
// above the new-file and web-search fallbacks.

import { dropUrlEntriesCoveredByHistoryRows } from './open-tab-entry-dedupe'
import {
  isActiveEntryOption,
  type ActiveOption,
  type BrowserHistoryOmniboxRow
} from './tab-create-entry-active-option'
import type { TabEntryOption } from './tab-create-entry-action'

// Leaving the workspace is the heavier action, so a local file outranks a
// remembered page even when the match was fuzzy.
function isFileOrUrlOption(option: TabEntryOption): boolean {
  const { kind } = option.classification
  return (
    kind === 'existing-file' ||
    kind === 'absolute-file' ||
    kind === 'explicit-url' ||
    kind === 'host-url'
  )
}

export function insertHistoryRowsBelowFileMatches(
  entryOptions: readonly TabEntryOption[],
  historyRows: readonly BrowserHistoryOmniboxRow[]
): readonly ActiveOption[] {
  const options = dropUrlEntriesCoveredByHistoryRows(entryOptions, historyRows)
    .filter(isActiveEntryOption)
    .map((option) => ({ kind: 'entry' as const, option }))
  if (historyRows.length === 0) {
    return options
  }
  // Scanning for the last one, not the leading run: the classifier promotes web
  // search above fuzzy files for phrase queries, and history belongs under both.
  let insertAt = 0
  for (const [index, option] of options.entries()) {
    if (isFileOrUrlOption(option.option)) {
      insertAt = index + 1
    }
  }
  return [
    ...options.slice(0, insertAt),
    ...historyRows.map((option) => ({ kind: 'history' as const, option })),
    ...options.slice(insertAt)
  ]
}
