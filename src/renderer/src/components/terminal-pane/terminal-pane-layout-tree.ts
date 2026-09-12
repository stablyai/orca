import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'

export function collectLeafIds(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  const leafIds: string[] = []
  const pending = [node]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.type === 'leaf') {
      leafIds.push(current.leafId)
      continue
    }
    pending.push(current.second, current.first)
  }
  return leafIds
}

export function pruneLeaves(
  node: TerminalPaneLayoutNode,
  retainedLeafIdByRemovedLeafId: ReadonlyMap<string, string>,
  retainedSelfLeafIds: Set<string>
): TerminalPaneLayoutNode | null {
  const pending: { node: TerminalPaneLayoutNode; visited: boolean }[] = [{ node, visited: false }]
  const pruned: (TerminalPaneLayoutNode | null)[] = []
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.node.type === 'leaf') {
      const retainedLeafId = retainedLeafIdByRemovedLeafId.get(current.node.leafId)
      if (!retainedLeafId) {
        pruned.push(current.node)
      } else if (
        retainedLeafId === current.node.leafId &&
        !retainedSelfLeafIds.has(current.node.leafId)
      ) {
        retainedSelfLeafIds.add(current.node.leafId)
        pruned.push(current.node)
      } else {
        pruned.push(null)
      }
      continue
    }
    if (!current.visited) {
      pending.push({ node: current.node, visited: true })
      pending.push({ node: current.node.second, visited: false })
      pending.push({ node: current.node.first, visited: false })
      continue
    }
    const second = pruned.pop() ?? null
    const first = pruned.pop() ?? null
    if (first && second) {
      pruned.push(
        first === current.node.first && second === current.node.second
          ? current.node
          : { ...current.node, first, second }
      )
    } else {
      pruned.push(first ?? second)
    }
  }
  return pruned[0] ?? null
}
