import type { TabGroupLayoutNode } from '../../../../shared/types'
import type { TabSplitDirection } from './tabs'

function getDirectLayoutSiblingOnSplitSide(
  split: Extract<TabGroupLayoutNode, { type: 'split' }>,
  targetGroupId: string,
  splitDirection: TabSplitDirection
): string | null {
  const { first, second, direction } = split

  if (first.type === 'leaf' && first.groupId === targetGroupId) {
    if (direction === 'horizontal' && splitDirection === 'right' && second.type === 'leaf') {
      return second.groupId
    }
    if (direction === 'vertical' && splitDirection === 'down' && second.type === 'leaf') {
      return second.groupId
    }
  }

  if (second.type === 'leaf' && second.groupId === targetGroupId) {
    if (direction === 'horizontal' && splitDirection === 'left' && first.type === 'leaf') {
      return first.groupId
    }
    if (direction === 'vertical' && splitDirection === 'up' && first.type === 'leaf') {
      return first.groupId
    }
  }

  return null
}

export function findLayoutSiblingOnSplitSide(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  splitDirection: TabSplitDirection
): string | null {
  if (root.type === 'leaf') {
    return null
  }

  const directSibling = getDirectLayoutSiblingOnSplitSide(root, targetGroupId, splitDirection)
  if (directSibling) {
    return directSibling
  }

  return (
    findLayoutSiblingOnSplitSide(root.first, targetGroupId, splitDirection) ??
    findLayoutSiblingOnSplitSide(root.second, targetGroupId, splitDirection)
  )
}

/** True when a pane-column split drop would collapse back to the current layout. */
export function isPaneColumnSplitDropNoOp(args: {
  sourceGroupId: string
  targetGroupId: string
  splitDirection: TabSplitDirection
  sourceTabCount: number
  layout: TabGroupLayoutNode | undefined
}): boolean {
  if (args.sourceGroupId === args.targetGroupId && args.sourceTabCount <= 1) {
    return true
  }
  if (args.sourceTabCount !== 1 || !args.layout) {
    return false
  }

  return (
    findLayoutSiblingOnSplitSide(args.layout, args.targetGroupId, args.splitDirection) ===
    args.sourceGroupId
  )
}
