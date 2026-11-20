import type { TabGroupLayoutNode } from '../../../../shared/workspace-layout/tab-groups/tab-types'

/** True when the layout subtree holds at least one chat-panel group. */
export function subtreeHasChatGroup(
  node: TabGroupLayoutNode,
  chatGroupIds: ReadonlySet<string>
): boolean {
  if (node.type === 'leaf') {
    return chatGroupIds.has(node.groupId)
  }
  return (
    subtreeHasChatGroup(node.first, chatGroupIds) || subtreeHasChatGroup(node.second, chatGroupIds)
  )
}
