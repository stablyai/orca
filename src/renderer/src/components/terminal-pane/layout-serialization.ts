import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

export const EMPTY_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

export function paneLeafId(paneId: number): string {
  return `pane:${paneId}`
}

export function buildFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  // Always include fallbacks
  if (!parts.some((p) => p.toLowerCase().includes('sf mono'))) {
    parts.push('"SF Mono"')
  }
  parts.push('Menlo', 'monospace')
  return parts.join(', ')
}

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
    const paneId = Number(node.dataset.paneId ?? '')
    if (!Number.isFinite(paneId)) {
      return null
    }
    return { type: 'leaf', leafId: paneLeafId(paneId) }
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
  // We read the computed flex-grow values to derive the first-child proportion.
  let ratio: number | undefined
  if (first && second) {
    const firstGrow = parseFloat(first.style.flex) || 1
    const secondGrow = parseFloat(second.style.flex) || 1
    const total = firstGrow + secondGrow
    if (total > 0) {
      const r = firstGrow / total
      // Only store if meaningfully different from 0.5 (default equal split)
      if (Math.abs(r - 0.5) > 0.005) {
        ratio = Math.round(r * 1000) / 1000
      }
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
  expandedPaneId: number | null
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  return {
    root: rootNode,
    activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
    expandedLeafId: expandedPaneId === null ? null : paneLeafId(expandedPaneId)
  }
}

function collectLeafIds(
  node: TerminalPaneLayoutNode,
  paneByLeafId: Map<string, number>,
  paneId: number
): void {
  if (node.type === 'leaf') {
    paneByLeafId.set(node.leafId, paneId)
    return
  }
  collectLeafIds(node.first, paneByLeafId, paneId)
  collectLeafIds(node.second, paneByLeafId, paneId)
}

export function replayTerminalLayout(
  manager: PaneManager,
  snapshot: TerminalLayoutSnapshot | null | undefined,
  focusInitialPane: boolean
): Map<string, number> {
  const paneByLeafId = new Map<string, number>()

  const initialPane = manager.createInitialPane({ focus: focusInitialPane })
  if (!snapshot?.root) {
    paneByLeafId.set(paneLeafId(initialPane.id), initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdPane = manager.splitPane(paneId, node.direction as TerminalPaneSplitDirection, {
      ratio: node.ratio
    })
    if (!createdPane) {
      collectLeafIds(node, paneByLeafId, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)
  return paneByLeafId
}
