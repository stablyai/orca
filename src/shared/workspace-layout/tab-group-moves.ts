import type { TabGroupLayoutNode } from '../tab-types'
import { buildSplitNode, replaceLeaf } from './tab-group-layout-tree'
import type { LayoutGroup } from './workspace-layout-model'

/**
 * Headless ("Orca server") tab-GROUP split operations (distinct from terminal
 * PANE splits inside one tab). The headless host historically coalesced every
 * tab into a single group, so a client drag-to-split-group was lost on the next
 * snapshot. These pure helpers let the host model + persist a real multi-group
 * layout, sharing the renderer's group tree operations so host and client
 * agree on the tree. Groups are order and membership only; a caller keeping a per-view
 * selected tab adapts it.
 */

type SplitDirection = 'left' | 'right' | 'up' | 'down'

/** Collect every groupId referenced by a layout tree. */
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

/** Remove a leaf from the tree, collapsing the parent split into the sibling. */
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

/**
 * Move `tabId` into an EXISTING `targetGroupId` (a non-split drop), mirroring the
 * renderer's move-to-group path. Inserts at `index` (clamped), removes the tab
 * from its source group, and drops a source group emptied by the move (collapsing
 * it out of the layout). Returns null when the tab/target is missing or it's a
 * same-group no-op.
 */
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

/**
 * Move `tabId` out of its current group into a NEW group split off from
 * `targetGroupId` in `splitDirection`, mirroring the renderer's dropUnifiedTab
 * split path. Returns the next groups + group layout tree.
 *
 * Returns null when the move can't apply (tab/group missing, or it would split
 * the only tab off its own group — a renderer-side no-op).
 */
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
  // Splitting the last tab off its own group would create a sibling only to
  // immediately collapse the empty source — a no-op the renderer skips too.
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
  // Drop any group emptied by the move and collapse it out of the layout.
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
