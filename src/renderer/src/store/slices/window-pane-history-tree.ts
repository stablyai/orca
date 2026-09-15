import type { TabGroupLayoutNode } from '../../../../shared/tab-types'

function leaves(node: TabGroupLayoutNode): string[] {
  return node.type === 'leaf' ? [node.groupId] : [...leaves(node.first), ...leaves(node.second)]
}

export function restoreMissingPane(
  root: TabGroupLayoutNode,
  before: TabGroupLayoutNode,
  id: string
): TabGroupLayoutNode {
  if (leaves(root).includes(id) || before.type === 'leaf') {
    return root
  }
  const side =
    before.first.type === 'leaf' && before.first.groupId === id
      ? 'first'
      : before.second.type === 'leaf' && before.second.groupId === id
        ? 'second'
        : null
  if (!side) {
    return restoreMissingPane(restoreMissingPane(root, before.first, id), before.second, id)
  }
  const sibling = side === 'first' ? before.second : before.first
  const surviving = leaves(sibling).filter((entry) => leaves(root).includes(entry))
  const insert = (node: TabGroupLayoutNode): TabGroupLayoutNode => {
    if (node.type === 'split' && surviving.length) {
      if (surviving.every((entry) => leaves(node.first).includes(entry))) {
        return { ...node, first: insert(node.first) }
      }
      if (surviving.every((entry) => leaves(node.second).includes(entry))) {
        return { ...node, second: insert(node.second) }
      }
    }
    return {
      ...before,
      first: side === 'first' ? before.first : node,
      second: side === 'second' ? before.second : node
    }
  }
  return insert(root)
}
