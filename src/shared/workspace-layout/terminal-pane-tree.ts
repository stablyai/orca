import { isTerminalLeafId } from '../stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../terminal-tab-types'

/** The pane a rootless layout names: its active leaf, else its only bound leaf. */
export function resolveRootlessTerminalLayoutLeafId(
  snapshot: Pick<TerminalLayoutSnapshot, 'activeLeafId' | 'ptyIdsByLeafId'>
): string | null {
  if (snapshot.activeLeafId && isTerminalLeafId(snapshot.activeLeafId)) {
    return snapshot.activeLeafId
  }
  const boundLeafIds = Object.keys(snapshot.ptyIdsByLeafId ?? {}).filter(isTerminalLeafId)
  return boundLeafIds.length === 1 ? boundLeafIds[0] : null
}

export function collectLayoutLeafIdsInOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLayoutLeafIdsInOrder(node.first), ...collectLayoutLeafIdsInOrder(node.second)]
}

export function firstLayoutLeafId(node: TerminalPaneLayoutNode | null): string | null {
  if (!node) {
    return null
  }
  return node.type === 'leaf' ? node.leafId : firstLayoutLeafId(node.first)
}

export function layoutContainsLeafId(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeafId(node.first, leafId) || layoutContainsLeafId(node.second, leafId)
}

export function removeLayoutLeaf(
  node: TerminalPaneLayoutNode | null,
  leafId: string
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId ? null : node
  }
  const first = removeLayoutLeaf(node.first, leafId)
  const second = removeLayoutLeaf(node.second, leafId)
  if (!first || !second) {
    return first ?? second
  }
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

export type PaneSide = 'left' | 'right' | 'top' | 'bottom'

export function insertLeafBeside(
  node: TerminalPaneLayoutNode,
  targetLeafId: string,
  newLeafId: string,
  side: PaneSide,
  ratio?: number
): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    if (node.leafId !== targetLeafId) {
      return node
    }
    const added: TerminalPaneLayoutNode = { type: 'leaf', leafId: newLeafId }
    const before = side === 'left' || side === 'top'
    return {
      type: 'split',
      direction: side === 'left' || side === 'right' ? 'vertical' : 'horizontal',
      first: before ? added : node,
      second: before ? node : added,
      ...(ratio !== undefined ? { ratio } : {})
    }
  }
  return {
    ...node,
    first: insertLeafBeside(node.first, targetLeafId, newLeafId, side, ratio),
    second: insertLeafBeside(node.second, targetLeafId, newLeafId, side, ratio)
  }
}

export function samePanesIgnoringRatios(
  left: TerminalPaneLayoutNode,
  right: TerminalPaneLayoutNode
): boolean {
  if (left.type === 'leaf' || right.type === 'leaf') {
    return (
      left.type === right.type &&
      left.type === 'leaf' &&
      right.type === 'leaf' &&
      left.leafId === right.leafId
    )
  }
  return (
    left.direction === right.direction &&
    samePanesIgnoringRatios(left.first, right.first) &&
    samePanesIgnoringRatios(left.second, right.second)
  )
}

function equalizeWeight(
  node: TerminalPaneLayoutNode,
  direction: 'vertical' | 'horizontal'
): number {
  return node.type === 'split' && node.direction === direction
    ? equalizeWeight(node.first, direction) + equalizeWeight(node.second, direction)
    : 1
}

/** A ratio this close to an even split is saved as none, as the desktop window saves it. */
export const SPLIT_RATIO_TOLERANCE = 0.005

/** Same-axis panes get equal shares, so three side by side become thirds, as the window does. */
export function equalizeLayout(node: TerminalPaneLayoutNode): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    return node
  }
  const first = equalizeWeight(node.first, node.direction)
  const second = equalizeWeight(node.second, node.direction)
  const { ratio: _ratio, ...split } = node
  const ratio = first / (first + second)
  return {
    ...split,
    ...(Math.abs(ratio - 0.5) > SPLIT_RATIO_TOLERANCE
      ? { ratio: Math.round(ratio * 1000) / 1000 }
      : {}),
    first: equalizeLayout(node.first),
    second: equalizeLayout(node.second)
  }
}
