import type { WorkspaceLayout } from '../workspace-layout-model'
import type { TabGroupLayoutNode } from '../../tab-types'

/** A workspace's groups in its group layout's order; groups the layout misses go last. */
export function groupsInLayoutOrder(workspace: WorkspaceLayout): WorkspaceLayout['groups'] {
  const ids: string[] = []
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (node?.type === 'leaf') {
      ids.push(node.groupId)
    } else if (node) {
      visit(node.first)
      visit(node.second)
    }
  }
  visit(workspace.groupLayout)
  const placed = ids.flatMap((id) => workspace.groups.filter((group) => group.id === id))
  return [...placed, ...workspace.groups.filter((group) => !placed.includes(group))]
}
