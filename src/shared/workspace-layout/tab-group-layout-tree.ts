import type { TabGroupLayoutNode } from '../tab-types'

export function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: 'horizontal' | 'vertical',
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const existingLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: existingGroupId }
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : existingLeaf,
    second: position === 'second' ? newLeaf : existingLeaf,
    ratio: 0.5
  }
}

export function replaceLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  replacement: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? replacement : root
  }
  return {
    ...root,
    first: replaceLeaf(root.first, targetGroupId, replacement),
    second: replaceLeaf(root.second, targetGroupId, replacement)
  }
}

export function updateSplitRatio(
  root: TabGroupLayoutNode,
  path: string[],
  ratio: number
): TabGroupLayoutNode {
  if (path.length === 0) {
    return root.type === 'split' ? { ...root, ratio } : root
  }
  if (root.type !== 'split') {
    return root
  }
  const [segment, ...rest] = path
  if (segment === 'first') {
    return { ...root, first: updateSplitRatio(root.first, rest, ratio) }
  }
  if (segment === 'second') {
    return { ...root, second: updateSplitRatio(root.second, rest, ratio) }
  }
  return root
}

function findFirstLeaf(root: TabGroupLayoutNode): string {
  return root.type === 'leaf' ? root.groupId : findFirstLeaf(root.first)
}

export function findSiblingGroupId(root: TabGroupLayoutNode, targetGroupId: string): string | null {
  if (root.type === 'leaf') {
    return null
  }
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second.type === 'leaf' ? root.second.groupId : findFirstLeaf(root.second)
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first.type === 'leaf' ? root.first.groupId : findFirstLeaf(root.first)
  }
  return (
    findSiblingGroupId(root.first, targetGroupId) ?? findSiblingGroupId(root.second, targetGroupId)
  )
}

export function removeGroupLayoutLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? null : root
  }
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first
  }
  const first = removeGroupLayoutLeaf(root.first, targetGroupId)
  const second = removeGroupLayoutLeaf(root.second, targetGroupId)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  return { ...root, first, second }
}

/** Builds a record from `previous` with one entry set, or deleted for null; the renderer passes its seam helper. */
export type ReplaceRecordEntries = <V>(
  previous: Readonly<Record<string, V>>,
  replacements: Iterable<readonly [key: string, value: V | null]>
) => Record<string, V>

export function collapseGroupLayout(
  layoutByWorktree: Record<string, TabGroupLayoutNode>,
  activeGroupIdByWorktree: Record<string, string>,
  worktreeId: string,
  groupId: string,
  fallbackGroupId: string | null | undefined,
  replaceEntries: ReplaceRecordEntries
): {
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorktree: Record<string, string>
} {
  const currentLayout = layoutByWorktree[worktreeId]
  if (!currentLayout) {
    return { layoutByWorktree, activeGroupIdByWorktree }
  }
  const collapsed = collapseWorktreeGroupLayout(
    currentLayout,
    activeGroupIdByWorktree[worktreeId],
    groupId,
    fallbackGroupId
  )
  return {
    layoutByWorktree: replaceEntries(layoutByWorktree, [[worktreeId, collapsed.layout]]),
    activeGroupIdByWorktree: replaceEntries(activeGroupIdByWorktree, [
      [worktreeId, collapsed.activeGroupId]
    ])
  }
}

/** collapseGroupLayout's values for its one worktree: a null layout deletes the entry. */
export function collapseWorktreeGroupLayout<A extends string | undefined>(
  currentLayout: TabGroupLayoutNode,
  currentActiveGroupId: A,
  groupId: string,
  fallbackGroupId?: string | null
): { layout: TabGroupLayoutNode | null; activeGroupId: string | A } {
  return {
    layout: removeGroupLayoutLeaf(currentLayout, groupId),
    activeGroupId:
      findSiblingGroupId(currentLayout, groupId) ?? fallbackGroupId ?? currentActiveGroupId
  }
}

/** Moves an existing group's leaf to `side` of another group; the moved group keeps its id. */
export function moveGroupLeafBeside(
  root: TabGroupLayoutNode,
  groupId: string,
  besideGroupId: string,
  side: 'left' | 'right' | 'up' | 'down'
): TabGroupLayoutNode {
  const rest = removeGroupLayoutLeaf(root, groupId) ?? { type: 'leaf', groupId: besideGroupId }
  const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
  const position = side === 'left' || side === 'up' ? 'first' : 'second'
  return replaceLeaf(
    rest,
    besideGroupId,
    buildSplitNode(besideGroupId, groupId, direction, position)
  )
}

function holdsGroup(node: TabGroupLayoutNode, groupId: string): boolean {
  return node.type === 'leaf'
    ? node.groupId === groupId
    : holdsGroup(node.first, groupId) || holdsGroup(node.second, groupId)
}

/** Move beside the smallest branch containing both groups (or the single matching group); null if none contains both. */
export function moveGroupLeafBesideBranch(
  root: TabGroupLayoutNode,
  groupId: string,
  fromGroupId: string,
  toGroupId: string,
  side: 'left' | 'right' | 'up' | 'down'
): TabGroupLayoutNode | null {
  const leaf: TabGroupLayoutNode = { type: 'leaf', groupId }
  const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
  const leafFirst = side === 'left' || side === 'up'
  const besideBranch = (node: TabGroupLayoutNode): TabGroupLayoutNode | null => {
    if (!holdsGroup(node, fromGroupId) || !holdsGroup(node, toGroupId)) {
      return null
    }
    if (node.type === 'split') {
      const first = besideBranch(node.first)
      if (first) {
        return { ...node, first }
      }
      const second = besideBranch(node.second)
      if (second) {
        return { ...node, second }
      }
    }
    return {
      type: 'split',
      direction,
      first: leafFirst ? leaf : node,
      second: leafFirst ? node : leaf,
      ratio: 0.5
    }
  }
  const rest = removeGroupLayoutLeaf(root, groupId)
  return rest && besideBranch(rest)
}
