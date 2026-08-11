import {
  applySourceControlFolderCompaction,
  buildSourceControlTree,
  type SourceControlTreeNode
} from '../../source-control-tree'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'

export const GIT_HISTORY_COMMIT_TREE_AREA = 'commit'

export type GitHistoryCommitTreeNode = SourceControlTreeNode<
  GitBranchChangeEntry,
  typeof GIT_HISTORY_COMMIT_TREE_AREA
>

// Why: uncompacted keeps `depth` at the real path depth the builder assigns, so every
// package segment gets its own indented row; compacting collapses single-child chains.
export function buildGitHistoryCommitFileTree(
  entries: GitBranchChangeEntry[],
  compactFolders = false
): GitHistoryCommitTreeNode[] {
  return applySourceControlFolderCompaction(
    buildSourceControlTree(GIT_HISTORY_COMMIT_TREE_AREA, entries),
    compactFolders
  )
}
