import { basename } from '@/lib/path'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type CombinedDiffFileTreeMode = 'all' | 'uncommitted' | 'branch' | 'commit'
export type CombinedDiffFileTreeEntry = GitStatusEntry | GitBranchChangeEntry
export type CombinedDiffBranchTreeArea = 'combined-branch' | 'combined-commit'

export const NO_EXTENSION_KEY = '(no extension)'
export const COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES = 2 * 1024

export function isCombinedDiffFileTreeQueryTooLarge(
  query: string,
  maxBytes = COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getCombinedDiffFileTreeSectionKey(
  mode: CombinedDiffFileTreeMode,
  entry: CombinedDiffFileTreeEntry
): string {
  if ((mode === 'all' || mode === 'uncommitted') && 'area' in entry) {
    return `${entry.area}:${entry.path}`
  }
  return `${mode === 'commit' ? 'combined-commit' : 'combined-branch'}:${entry.path}`
}

export function createCombinedDiffSectionIndexMap(
  sections: readonly { key: string }[]
): Map<string, number> {
  return new Map(sections.map((section, index) => [section.key, index]))
}

export function getCombinedDiffFileTreeNavigationIndex({
  mode,
  entry,
  sectionIndexByKey
}: {
  mode: CombinedDiffFileTreeMode
  entry: CombinedDiffFileTreeEntry
  sectionIndexByKey: ReadonlyMap<string, number>
}): number | null {
  return sectionIndexByKey.get(getCombinedDiffFileTreeSectionKey(mode, entry)) ?? null
}

export function handleCombinedDiffFileTreeNavigation({
  mode,
  entry,
  sections,
  sectionIndexByKey,
  toggleSection,
  scrollToIndex
}: {
  mode: CombinedDiffFileTreeMode
  entry: CombinedDiffFileTreeEntry
  sections: readonly { collapsed: boolean }[]
  sectionIndexByKey: ReadonlyMap<string, number>
  toggleSection: (index: number) => void
  scrollToIndex: (index: number) => void
}): number | null {
  const index = getCombinedDiffFileTreeNavigationIndex({ mode, entry, sectionIndexByKey })
  if (index === null || !sections[index]) {
    return null
  }

  if (sections[index].collapsed) {
    toggleSection(index)
  }
  scrollToIndex(index)
  return index
}

export function isGitStatusEntry(entry: CombinedDiffFileTreeEntry): entry is GitStatusEntry {
  return 'area' in entry
}

export function getEntryExtension(entry: CombinedDiffFileTreeEntry): string {
  const name = basename(entry.path)
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) {
    return NO_EXTENSION_KEY
  }
  return name.slice(index).toLowerCase()
}

function getEntrySearchText(entry: CombinedDiffFileTreeEntry): string {
  return [entry.path, entry.oldPath ?? '', entry.status, isGitStatusEntry(entry) ? entry.area : '']
    .join(' ')
    .toLowerCase()
}

export function getFilteredCombinedDiffFileTreeEntries({
  entries,
  mode,
  query,
  excludedExtensions,
  includeViewed,
  viewedSectionKeys
}: {
  entries: readonly CombinedDiffFileTreeEntry[]
  mode: CombinedDiffFileTreeMode
  query: string
  excludedExtensions: ReadonlySet<string>
  includeViewed: boolean
  viewedSectionKeys: ReadonlySet<string>
}): CombinedDiffFileTreeEntry[] {
  if (isCombinedDiffFileTreeQueryTooLarge(query)) {
    return []
  }
  const trimmedQuery = query.trim()
  const normalizedQuery = trimmedQuery.toLowerCase()
  return entries.filter((entry) => {
    if (excludedExtensions.has(getEntryExtension(entry))) {
      return false
    }
    if (!includeViewed && viewedSectionKeys.has(getCombinedDiffFileTreeSectionKey(mode, entry))) {
      return false
    }
    return normalizedQuery.length === 0 || getEntrySearchText(entry).includes(normalizedQuery)
  })
}
