// An open editor tab and its file on disk are the same destination, so the
// switch row wins and the omnibox never offers to reopen what is already open.

import { normalizeRelativePath } from '@/lib/path'
import { isCaseInsensitiveRuntimeRoot } from '../../../../shared/cross-platform-path'
import type { OpenTabSearchResult } from './open-tab-search'
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
