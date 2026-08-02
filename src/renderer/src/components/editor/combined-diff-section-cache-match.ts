import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import type { CombinedDiffFileTreeMode } from './combined-diff-file-tree-model'
import { getCombinedDiffFileTreeSectionKey } from './combined-diff-file-tree-model'
import type { DiffSection } from './diff-section-types'

export function combinedDiffSectionsMatchEntryMetadata({
  entries,
  sections,
  treeMode
}: {
  entries: readonly (GitStatusEntry | GitBranchChangeEntry)[]
  sections: readonly DiffSection[]
  treeMode: CombinedDiffFileTreeMode
}): boolean {
  // Why: same-path combined sections can survive status refreshes; metadata
  // drift means restoring cached content would replay stale, partial diffs.
  return (
    sections.length === entries.length &&
    sections.every((section, index) => {
      const entry = entries[index]
      if (!entry) {
        return false
      }
      const entryArea = 'area' in entry ? entry.area : undefined
      const entryAdded = 'added' in entry ? entry.added : undefined
      const entryRemoved = 'removed' in entry ? entry.removed : undefined
      return (
        section.key === getCombinedDiffFileTreeSectionKey(treeMode, entry) &&
        section.status === entry.status &&
        section.area === entryArea &&
        section.oldPath === entry.oldPath &&
        section.added === entryAdded &&
        section.removed === entryRemoved
      )
    })
  )
}
