// Where the browser-history block lands inside the omnibox entry rows: with the
// typed URL when the query is a web address, otherwise below every file the
// query matched and above the new-file and web-search fallbacks.

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

// Leaving the workspace is the heavier action, so a local file outranks a
// remembered page even when the match was fuzzy.
function isFileOption(option: TabEntryOption): boolean {
  const { kind } = option.classification
  return kind === 'existing-file' || kind === 'absolute-file'
}

function historyInsertIndex(
  options: readonly ActiveEntryOption[],
  keptOptions: readonly ActiveEntryOption[]
): number {
  // History sits with the typed URL row (in its slot once it replaced it), so
  // visiting a site never changes what Enter does on its name.
  const urlIndex = options.findIndex(isTypedUrlOption)
  if (urlIndex !== -1) {
    return keptOptions.includes(options[urlIndex]) ? urlIndex + 1 : urlIndex
  }
  // Scanning for the last one, not the leading run: the classifier promotes web
  // search above fuzzy files for phrase queries, and history belongs under both.
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
