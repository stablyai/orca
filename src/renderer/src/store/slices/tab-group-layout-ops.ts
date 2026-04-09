import type { TabGroupLayoutNode, TabGroupSplitDirection } from '../../../../shared/types'

/**
 * Replace a leaf node with a new node (typically a split containing the original leaf
 * and a new leaf). Used by splitTabToGroup to insert a new group adjacent to an existing one.
 */
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

/**
 * Build the split node that replaces a leaf when splitting a group.
 * `position` is where the NEW group appears relative to the original.
 */
export function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: TabGroupSplitDirection,
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const existingLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: existingGroupId }
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : existingLeaf,
    second: position === 'second' ? newLeaf : existingLeaf
  }
}

/**
 * Remove a leaf and promote its sibling to take the parent's place.
 * Returns null if the root itself is the removed leaf (tree is now empty).
 */
export function removeLeaf(root: TabGroupLayoutNode, groupId: string): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return root.groupId === groupId ? null : root
  }

  // If one direct child is the target leaf, promote the other child
  if (root.first.type === 'leaf' && root.first.groupId === groupId) {
    return root.second
  }
  if (root.second.type === 'leaf' && root.second.groupId === groupId) {
    return root.first
  }

  // Recurse into children
  const newFirst = removeLeaf(root.first, groupId)
  const newSecond = removeLeaf(root.second, groupId)

  // If a subtree collapsed to null, promote the other
  if (newFirst === null) {
    return newSecond
  }
  if (newSecond === null) {
    return newFirst
  }

  return { ...root, first: newFirst, second: newSecond }
}

/**
 * Find the nearest sibling group for focus fallback when a group is removed.
 * Returns the groupId of the sibling in the same parent split, or null.
 */
export function findSiblingGroupId(root: TabGroupLayoutNode, groupId: string): string | null {
  if (root.type === 'leaf') {
    return null
  }

  // Check if one direct child is the target — if so, return first leaf of the other
  if (root.first.type === 'leaf' && root.first.groupId === groupId) {
    return firstLeafGroupId(root.second)
  }
  if (root.second.type === 'leaf' && root.second.groupId === groupId) {
    return firstLeafGroupId(root.first)
  }

  // Recurse
  return findSiblingGroupId(root.first, groupId) ?? findSiblingGroupId(root.second, groupId)
}

/** Collect all group IDs present in the layout tree. */
export function collectGroupIds(root: TabGroupLayoutNode): string[] {
  if (root.type === 'leaf') {
    return [root.groupId]
  }
  return [...collectGroupIds(root.first), ...collectGroupIds(root.second)]
}

function firstLeafGroupId(node: TabGroupLayoutNode): string {
  if (node.type === 'leaf') {
    return node.groupId
  }
  return firstLeafGroupId(node.first)
}
