import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { removeGroupLayoutLeaf } from '../../../shared/workspace-layout/tab-group-layout-tree'
import type { NewGroupSplit } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { TabsSlice } from '@/store/slices/tabs/tabs-slice-contract'

/**
 * The split that made a just-opened tab's group, when the group holds no other tab. Main stores no
 * empty group, so it lacks that group (the window made it with the tab, or empty before) and makes
 * it with the tab, beside the sibling branch, read off the window's tree without the other empty
 * groups main lacks too. None for what is then the workspace's only group. `state` may predate
 * the tab (an editor open passes the store from before it).
 */
export function newGroupSplitOf(
  state: Pick<TabsSlice, 'groupsByWorktree' | 'layoutByWorktree'>,
  worktreeId: string,
  groupId: string,
  tabId: string
): { split: NewGroupSplit } | null {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const group = groups.find((entry) => entry.id === groupId)
  const layout = state.layoutByWorktree[worktreeId]
  if (!group || group.tabOrder.some((id) => id !== tabId) || !layout) {
    return null
  }
  let held: TabGroupLayoutNode | null = layout
  for (const other of groups) {
    if (held && other.id !== groupId && other.tabOrder.length === 0) {
      held = removeGroupLayoutLeaf(held, other.id)
    }
  }
  return held ? splitBeside(held, groupId) : null
}

function splitBeside(node: TabGroupLayoutNode, groupId: string): { split: NewGroupSplit } | null {
  if (node.type === 'leaf') {
    return null
  }
  const isFirst = node.first.type === 'leaf' && node.first.groupId === groupId
  const isSecond = node.second.type === 'leaf' && node.second.groupId === groupId
  if (!isFirst && !isSecond) {
    return splitBeside(node.first, groupId) ?? splitBeside(node.second, groupId)
  }
  const sibling = isFirst ? node.second : node.first
  const sides =
    node.direction === 'horizontal' ? (['left', 'right'] as const) : (['up', 'down'] as const)
  const besideGroupId = edgeGroupId(sibling, 'first')
  const besideLastGroupId = edgeGroupId(sibling, 'second')
  return {
    split: {
      besideGroupId,
      ...(besideLastGroupId !== besideGroupId ? { besideLastGroupId } : {}),
      direction: sides[isFirst ? 0 : 1]
    }
  }
}

function edgeGroupId(node: TabGroupLayoutNode, edge: 'first' | 'second'): string {
  return node.type === 'leaf' ? node.groupId : edgeGroupId(node[edge], edge)
}
