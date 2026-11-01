// Prefer switching to an open editor over reopening its on-disk file.

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
    // Only editable file tabs replace file destinations; other path-bearing tab kinds remain separate.
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

// Prefer switching to an existing browser page over navigating its history URL again.
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

// Prefer titled history rows over equivalent bare typed-URL entries.
export function dropUrlEntriesCoveredByHistoryRows<Option extends TabEntryOption>(
  options: readonly Option[],
  rows: readonly BrowserHistoryOmniboxRow[]
): readonly Option[] {
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
