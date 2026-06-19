import { getDiscardAllPaths, getStageAllPaths, getUnstageAllPaths } from './discard-all-sequence'
import {
  collectSourceControlTreeFileEntries,
  type SourceControlTreeDirectoryNode
} from './source-control-tree'
import type { GitStatusEntry } from '../../../../shared/types'

export type SourceControlDirectoryActionPaths = {
  stagePaths: string[]
  unstagePaths: string[]
  discardPaths: string[]
}

export function getSourceControlDirectoryActionPaths(
  node: SourceControlTreeDirectoryNode<GitStatusEntry>
): SourceControlDirectoryActionPaths {
  const entries = collectSourceControlTreeFileEntries(node)
  return {
    stagePaths:
      node.area === 'unstaged' || node.area === 'untracked'
        ? getStageAllPaths(entries, node.area)
        : [],
    unstagePaths: node.area === 'staged' ? getUnstageAllPaths(entries) : [],
    discardPaths:
      node.area === 'unstaged' || node.area === 'untracked'
        ? getDiscardAllPaths(entries, node.area)
        : []
  }
}
