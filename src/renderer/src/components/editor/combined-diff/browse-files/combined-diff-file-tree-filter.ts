import { basename } from '@/lib/path'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import { isClipboardTextByteLengthOverLimit } from '../../../../../../shared/clipboard-text'
import {
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree
} from '@/components/right-sidebar/source-control-tree'
import {
  getCombinedDiffFileTreeSectionKey,
  isGitStatusEntry,
  type CombinedDiffBranchTreeArea,
  type CombinedDiffFileTreeEntry,
  type CombinedDiffFileTreeMode
} from '../resolve-changes/combined-diff-section-identity'

export const NO_EXTENSION_KEY = '(no extension)'
export const COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES = 2 * 1024

export function isCombinedDiffFileTreeQueryTooLarge(
  query: string,
  maxBytes = COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
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

export function getCombinedDiffBranchEntriesInTreeOrder(
  mode: Extract<CombinedDiffFileTreeMode, 'branch' | 'commit'>,
  entries: readonly GitBranchChangeEntry[]
): GitBranchChangeEntry[] {
  const area: CombinedDiffBranchTreeArea = mode === 'commit' ? 'combined-commit' : 'combined-branch'
  const roots = compactSourceControlTree(buildSourceControlTree(area, [...entries]))
  return flattenSourceControlTree(roots, new Set())
    .filter((node) => node.type === 'file')
    .map((node) => node.entry)
}
