import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

export type CombinedDiffFileTreeMode = 'all' | 'uncommitted' | 'branch' | 'commit'
export type CombinedDiffFileTreeEntry = GitStatusEntry | GitBranchChangeEntry
export type CombinedDiffBranchTreeArea = 'combined-branch' | 'combined-commit'

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

export function isGitStatusEntry(entry: CombinedDiffFileTreeEntry): entry is GitStatusEntry {
  return 'area' in entry
}
