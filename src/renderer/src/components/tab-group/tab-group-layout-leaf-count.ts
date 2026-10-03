import type { TabGroupLayoutNode } from '../../../../shared/types'

/** Total number of group leaves in a tab-group split tree (leaf → 1, split → sum of children). */
export function countLayoutLeaves(node: TabGroupLayoutNode): number {
  if (node.type === 'leaf') {
    return 1
  }
  return countLayoutLeaves(node.first) + countLayoutLeaves(node.second)
}
