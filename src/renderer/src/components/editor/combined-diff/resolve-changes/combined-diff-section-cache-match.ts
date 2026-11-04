import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { CombinedDiffFileTreeMode } from './combined-diff-section-identity'
import { getCombinedDiffFileTreeSectionKey } from './combined-diff-section-identity'
import type { DiffSection } from '../../diff-section-types'

export function combinedDiffSectionMatchesEntryMetadata(
  section: DiffSection,
  entry: GitStatusEntry | GitBranchChangeEntry,
  treeMode: CombinedDiffFileTreeMode
): boolean {
  return (
    section.key === getCombinedDiffFileTreeSectionKey(treeMode, entry) &&
    section.status === entry.status &&
    section.area === ('area' in entry ? entry.area : undefined) &&
    section.oldPath === entry.oldPath &&
    section.added === entry.added &&
    section.removed === entry.removed
  )
}

export function combinedDiffSectionsMatchEntryMetadata({
  entries,
  sections,
  treeMode
}: {
  entries: readonly (GitStatusEntry | GitBranchChangeEntry)[]
  sections: readonly DiffSection[]
  treeMode: CombinedDiffFileTreeMode
}): boolean {
  // Same-path rows can change metadata; restoring mismatched cached sections would replay stale or partial diffs.
  return (
    sections.length === entries.length &&
    sections.every((section, index) => {
      const entry = entries[index]
      if (!entry) {
        return false
      }
      return combinedDiffSectionMatchesEntryMetadata(section, entry, treeMode)
    })
  )
}
