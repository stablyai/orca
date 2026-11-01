import type { TabGroupLayoutNode } from '../tab-types'
import { buildSplitNode, replaceLeaf } from './tab-group-layout-tree'
import type { LayoutGroup } from './workspace-layout-model'

/** Share group-tree operations with the renderer so headless drag splits survive the next persisted snapshot.
 * Groups hold membership/order; callers adapt per-view selections. These are tab-group splits, not terminal-pane splits. */

type SplitDirection = 'left' | 'right' | 'up' | 'down'

export function collectTabGroupLayoutGroupIds(
  node: TabGroupLayoutNode | null | undefined,
  groupIds = new Set<string>()
): Set<string> {
  if (!node) {
    return groupIds
  }
  if (node.type === 'leaf') {
    groupIds.add(node.groupId)
    return groupIds
  }
  collectTabGroupLayoutGroupIds(node.first, groupIds)
  collectTabGroupLayoutGroupIds(node.second, groupIds)
  return groupIds
}

export function removeTabGroupLayoutLeaf(
  root: TabGroupLayoutNode | null | undefined,
  groupId: string
): TabGroupLayoutNode | null {
  if (!root) {
    return null
  }
  if (root.type === 'leaf') {
    return root.groupId === groupId ? null : root
  }
  const first = removeTabGroupLayoutLeaf(root.first, groupId)
  const second = removeTabGroupLayoutLeaf(root.second, groupId)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...root, first, second }
}

export type HeadlessTabGroupMoveResult = {
  groups: LayoutGroup[]
  layout: TabGroupLayoutNode | null
}

/** Mirror renderer group moves: clamp insertion, remove the source entry and collapse emptied groups; null for missing tabs/targets or same-group no-ops. */
export function buildHeadlessTabGroupMove(args: {
  groups: readonly LayoutGroup[]
  layout: TabGroupLayoutNode | null | undefined
  tabId: string
  targetGroupId: string
  index?: number
}): HeadlessTabGroupMoveResult | null {
  const sourceGroup = args.groups.find((group) => group.tabOrder.includes(args.tabId))
  const targetGroup = args.groups.find((group) => group.id === args.targetGroupId)
  if (!sourceGroup || !targetGroup) {
    return null
  }
  if (sourceGroup.id === args.targetGroupId) {
    return null
  }

  let groups: LayoutGroup[] = args.groups.map((group) => {
    if (group.id === sourceGroup.id) {
      return { id: group.id, tabOrder: group.tabOrder.filter((id) => id !== args.tabId) }
    }
    if (group.id === args.targetGroupId) {
      const tabOrder = group.tabOrder.filter((id) => id !== args.tabId)
      const at = Math.max(0, Math.min(args.index ?? tabOrder.length, tabOrder.length))
      tabOrder.splice(at, 0, args.tabId)
      return { id: group.id, tabOrder }
    }
    return { id: group.id, tabOrder: group.tabOrder }
  })

  groups = groups.filter((group) => group.tabOrder.length > 0)
  const liveGroupIds = new Set(groups.map((group) => group.id))
  let layout: TabGroupLayoutNode | null = args.layout ?? null
  for (const groupId of collectTabGroupLayoutGroupIds(args.layout)) {
    if (!liveGroupIds.has(groupId)) {
      layout = removeTabGroupLayoutLeaf(layout, groupId)
    }
  }
  return { groups, layout }
}

export type HeadlessTabGroupSplitResult = {
  groups: LayoutGroup[]
  layout: TabGroupLayoutNode
  newGroupId: string
}

/** Move a tab into a new split group like renderer dropUnifiedTab; null for missing identities or splitting the only tab off its own group. */
export function buildHeadlessTabGroupSplit(args: {
  groups: readonly LayoutGroup[]
  layout: TabGroupLayoutNode | null | undefined
  tabId: string
  targetGroupId: string
  splitDirection: SplitDirection
  newGroupId: string
}): HeadlessTabGroupSplitResult | null {
  const sourceGroup = args.groups.find((group) => group.tabOrder.includes(args.tabId))
  if (!sourceGroup) {
    return null
  }
  // Splitting a sole tab off its own group immediately collapses the source; preserve the renderer’s no-op.
  if (sourceGroup.id === args.targetGroupId && sourceGroup.tabOrder.length <= 1) {
    return null
  }

  const direction =
    args.splitDirection === 'left' || args.splitDirection === 'right' ? 'horizontal' : 'vertical'
  const position =
    args.splitDirection === 'left' || args.splitDirection === 'up' ? 'first' : 'second'

  const baseLayout: TabGroupLayoutNode = args.layout ?? {
    type: 'leaf',
    groupId: args.targetGroupId
  }
  const layout = replaceLeaf(
    baseLayout,
    args.targetGroupId,
    buildSplitNode(args.targetGroupId, args.newGroupId, direction, position)
  )

  const sourceOrder = sourceGroup.tabOrder.filter((id) => id !== args.tabId)
  let groups: LayoutGroup[] = args.groups.map((group) => ({
    id: group.id,
    tabOrder: group.id === sourceGroup.id ? sourceOrder : group.tabOrder
  }))
  groups.push({ id: args.newGroupId, tabOrder: [args.tabId] })
  groups = groups.filter((group) => group.tabOrder.length > 0)
  const liveGroupIds = new Set(groups.map((group) => group.id))
  let prunedLayout: TabGroupLayoutNode | null = layout
  for (const groupId of collectTabGroupLayoutGroupIds(layout)) {
    if (!liveGroupIds.has(groupId)) {
      prunedLayout = removeTabGroupLayoutLeaf(prunedLayout, groupId)
    }
  }

  return {
    groups,
    layout: prunedLayout ?? { type: 'leaf', groupId: args.newGroupId },
    newGroupId: args.newGroupId
  }
}
