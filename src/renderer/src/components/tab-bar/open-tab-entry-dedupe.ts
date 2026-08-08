// An open editor tab and its file on disk are the same destination, so the
// switch row wins and the omnibox never offers to reopen what is already open.

import { normalizeRelativePath } from '@/lib/path'
import type { OpenTabSearchResult } from './open-tab-search'
import type { TabEntryOption } from './tab-create-entry-action'

export function dropFileEntriesCoveredByTabResults(
  options: readonly TabEntryOption[],
  tabResults: readonly OpenTabSearchResult[]
): readonly TabEntryOption[] {
  const openPaths = new Set<string>()
  for (const result of tabResults) {
    // Only editor-backed results carry a path; terminal, browser and simulator
    // rows must never suppress a file entry.
    if (result.source === 'workspace' && result.relativePath) {
      openPaths.add(normalizeRelativePath(result.relativePath))
    }
  }
  if (openPaths.size === 0) {
    return options
  }
  return options.filter(
    (option) =>
      option.classification.kind !== 'existing-file' ||
      !openPaths.has(normalizeRelativePath(option.classification.relativePath))
  )
}
