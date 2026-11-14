import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import { isTerminalLeafId } from '../../../../../shared/workspace-layout/stable-pane-id'
import { readSplitRatio } from '@/lib/pane-manager/pane-layout/pane-split-ratio'
import { SPLIT_RATIO_TOLERANCE } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'

export function getLayoutChildNodes(split: HTMLElement): HTMLElement[] {
  return Array.from(split.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

export function serializePaneTree(node: HTMLElement | null): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }

  if (node.classList.contains('pane')) {
    const leafId = node.dataset.leafId
    if (!leafId || !isTerminalLeafId(leafId)) {
      return null
    }
    return { type: 'leaf', leafId }
  }

  if (!node.classList.contains('pane-split')) {
    return null
  }
  const [first, second] = getLayoutChildNodes(node)
  const firstNode = serializePaneTree(first ?? null)
  const secondNode = serializePaneTree(second ?? null)
  if (!firstNode || !secondNode) {
    return null
  }

  // Capture the flex ratio so resized panes survive serialization round-trips.
  let ratio: number | undefined
  if (first && second) {
    const r = readSplitRatio(first, second)
    if (Math.abs(r - 0.5) > SPLIT_RATIO_TOLERANCE) {
      ratio = Math.round(r * 1000) / 1000
    }
  }

  return {
    type: 'split',
    direction: node.classList.contains('is-horizontal') ? 'horizontal' : 'vertical',
    first: firstNode,
    second: secondNode,
    ...(ratio !== undefined && { ratio })
  }
}

export function serializeTerminalLayout(
  root: HTMLDivElement | null,
  activePaneId: number | null,
  expandedPaneId: number | null,
  leafIdByPaneId?: ReadonlyMap<number, string>
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  const activeLeafId = activePaneId === null ? null : leafIdByPaneId?.get(activePaneId)
  const expandedLeafId = expandedPaneId === null ? null : leafIdByPaneId?.get(expandedPaneId)
  return {
    root: rootNode,
    activeLeafId: activeLeafId && isTerminalLeafId(activeLeafId) ? activeLeafId : null,
    expandedLeafId: expandedLeafId && isTerminalLeafId(expandedLeafId) ? expandedLeafId : null
  }
}
