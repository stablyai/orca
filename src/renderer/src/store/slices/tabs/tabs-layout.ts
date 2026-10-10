import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'

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

function removeLeaf(root: TabGroupLayoutNode, targetGroupId: string): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? null : root
  }
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first
  }
  const first = removeLeaf(root.first, targetGroupId)
  const second = removeLeaf(root.second, targetGroupId)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  return { ...root, first, second }
}

export function collapseGroupLayout(
  layoutByWorktree: Record<string, TabGroupLayoutNode>,
  activeGroupIdByWorktree: Record<string, string>,
  worktreeId: string,
  groupId: string,
  fallbackGroupId?: string | null
): {
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorktree: Record<string, string>
} {
  const currentLayout = layoutByWorktree[worktreeId]
  if (!currentLayout) {
    return { layoutByWorktree, activeGroupIdByWorktree }
  }
  const siblingId = findSiblingGroupId(currentLayout, groupId)
  const collapsed = removeLeaf(currentLayout, groupId)
  const nextLayoutByWorktree = { ...layoutByWorktree }
  if (collapsed) {
    nextLayoutByWorktree[worktreeId] = collapsed
  } else {
    delete nextLayoutByWorktree[worktreeId]
  }
  return {
    layoutByWorktree: nextLayoutByWorktree,
    activeGroupIdByWorktree: {
      ...activeGroupIdByWorktree,
      [worktreeId]: siblingId ?? fallbackGroupId ?? activeGroupIdByWorktree[worktreeId]
    }
  }
}
