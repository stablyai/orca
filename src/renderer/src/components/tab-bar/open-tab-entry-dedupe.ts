// An open editor tab and its file on disk are the same destination, so the
// switch row wins and the omnibox never offers to reopen what is already open.

import { normalizeRelativePath } from '@/lib/path'
import { isCaseInsensitiveRuntimeRoot } from '../../../../shared/cross-platform-path'
import { normalizeBrowserHistoryUrl } from '../../../../shared/workspace-session-browser-history'
import type { OpenTabSearchResult } from './open-tab-search'
import type { BrowserHistoryOmniboxRow } from './tab-create-entry-active-option'
import type { TabEntryOption } from './tab-create-entry-action'

// NFC so a macOS NFD directory listing matches the NFC path an editor recorded.
function comparisonKey(relativePath: string, foldCase: boolean): string {
  const normalized = normalizeRelativePath(relativePath).normalize('NFC')
  return foldCase ? normalized.toLowerCase() : normalized
}

export function dropFileEntriesCoveredByTabResults(
  options: readonly TabEntryOption[],
  tabResults: readonly OpenTabSearchResult[],
  worktreePath: string | null
): readonly TabEntryOption[] {
  // Folding follows the worktree's filesystem, not the client platform.
  const foldCase = worktreePath !== null && isCaseInsensitiveRuntimeRoot(worktreePath)
  const openPaths = new Set<string>()
  for (const result of tabResults) {
    // Only an open editor is the same destination as the file row; terminal,
    // diff, review, browser and simulator rows must never suppress it.
    if (result.source === 'workspace' && result.contentType === 'editor' && result.relativePath) {
      openPaths.add(comparisonKey(result.relativePath, foldCase))
    }
  }
  if (openPaths.size === 0) {
    return options
  }
  return options.filter(
    (option) =>
      option.classification.kind !== 'existing-file' ||
      !openPaths.has(comparisonKey(option.classification.relativePath, foldCase))
  )
}

// A page already open in a browser tab is the same destination as its history
// row, and switching beats navigating; the same trade the file rows above make.
export function dropHistoryRowsCoveredByBrowserPages(
  rows: readonly BrowserHistoryOmniboxRow[],
  tabResults: readonly OpenTabSearchResult[]
): readonly BrowserHistoryOmniboxRow[] {
  if (rows.length === 0) {
    return rows
  }
  const openUrls = new Set<string>()
  for (const result of tabResults) {
    if (result.source === 'browser') {
      openUrls.add(normalizeBrowserHistoryUrl(result.url))
    }
  }
  if (openUrls.size === 0) {
    return rows
  }
  const retained = rows.filter((row) => !openUrls.has(row.entry.normalizedUrl))
  return retained.length === rows.length ? rows : retained
}

// The history row carries a real page title, so it beats the bare typed-URL row
// it duplicates — mirroring the address bar's synthetic-row fold.
export function dropUrlEntriesCoveredByHistoryRows(
  options: readonly TabEntryOption[],
  rows: readonly BrowserHistoryOmniboxRow[]
): readonly TabEntryOption[] {
  if (rows.length === 0) {
    return options
  }
  const historyUrls = new Set(rows.map((row) => row.entry.normalizedUrl))
  const retained = options.filter(
    (option) =>
      (option.classification.kind !== 'explicit-url' &&
        option.classification.kind !== 'host-url') ||
      !historyUrls.has(normalizeBrowserHistoryUrl(option.classification.url))
  )
  return retained.length === options.length ? options : retained
}
