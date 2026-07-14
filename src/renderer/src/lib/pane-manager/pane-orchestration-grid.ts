import {
  buildOrchestrationTerminalGridRoot,
  getOrchestrationTerminalGridColumnCount
} from '../../../../shared/orchestration-terminal-grid'
import type { TerminalPaneLayoutNode, TerminalPaneSplitDirection } from '../../../../shared/types'
import {
  applyDividerStyles,
  createOrchestrationGridDivider,
  disposeDividersIn,
  getDividerHitSize
} from './pane-divider'
import type { ManagedPaneInternal, PaneStyleOptions } from './pane-manager-types'
import { clearPendingSplitScrollRestore, scheduleSplitScrollRestore } from './pane-split-scroll'
import { applyPaneFlexStyle, captureScrollState, safeFit } from './pane-tree-ops'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { disposeWebgl } from './pane-webgl-renderer'

type GridPaneMoveState = {
  pane: ManagedPaneInternal
  scrollState: ReturnType<typeof captureScrollState>
  shouldReattachWebgl: boolean
}

type ArrangeOrchestrationGridArgs = {
  root: HTMLElement
  panes: Map<number, ManagedPaneInternal>
  leafIds?: readonly string[]
  styleOptions: PaneStyleOptions
  isDestroyed: () => boolean
  onLayoutChanged?: () => void
}

function preparePaneMoves(panes: Iterable<ManagedPaneInternal>): GridPaneMoveState[] {
  return [...panes].map((pane) => {
    // Why: restore replay reparents immediately before grid arrange, while
    // the original WebGL addon is detached pending its first settle timer.
    const shouldReattachWebgl = !!pane.webglAddon || pane.pendingSplitWebglReattach === true
    clearPendingSplitScrollRestore(pane)
    const scrollState = captureScrollState(pane.terminal)
    pane.pendingSplitScrollState = scrollState
    disposeWebgl(pane)
    return { pane, scrollState, shouldReattachWebgl }
  })
}

function resolveGridPaneOrder(
  panesById: ReadonlyMap<number, ManagedPaneInternal>,
  leafIds: readonly string[] | undefined
): ManagedPaneInternal[] {
  const currentOrder = [...panesById.values()]
  if (!leafIds || leafIds.length !== currentOrder.length) {
    return currentOrder
  }
  const paneByLeafId = new Map<string, ManagedPaneInternal>(
    currentOrder.map((pane) => [pane.leafId, pane])
  )
  const seen = new Set<string>()
  const restoredOrder: ManagedPaneInternal[] = []
  for (const leafId of leafIds) {
    const pane = paneByLeafId.get(leafId)
    if (!pane || seen.has(leafId)) {
      return currentOrder
    }
    seen.add(leafId)
    restoredOrder.push(pane)
  }
  // Why: replay creates second-subtree panes before descending into the first;
  // the complete saved leaf order, not Map insertion order, restores visual order.
  return restoredOrder
}

function persistGridPaneOrder(
  panesById: Map<number, ManagedPaneInternal>,
  panes: readonly ManagedPaneInternal[]
): void {
  panesById.clear()
  for (const pane of panes) {
    panesById.set(pane.id, pane)
  }
}

function gridAxisUnits(
  node: TerminalPaneLayoutNode,
  direction: TerminalPaneSplitDirection
): number {
  if (node.type === 'leaf') {
    return 1
  }
  const firstUnits = gridAxisUnits(node.first, direction)
  const secondUnits = gridAxisUnits(node.second, direction)
  return node.direction === direction ? firstUnits + secondUnits : Math.max(firstUnits, secondUnits)
}

function applyGridAxisFlex(element: HTMLElement, units: number, dividerHitSizePx: number): void {
  // Why: each binary subtree consumes fixed-width dividers before flex space;
  // reserving them leaves exactly one equal grow share for every grid unit.
  const internalDividerPixels = (units - 1) * dividerHitSizePx
  element.style.flex = `${units} 1 ${internalDividerPixels}px`
}

function getGridSplitContent(split: HTMLElement): HTMLElement[] {
  return [...split.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains('pane-divider')
  )
}

function applyPartialGridRowWidth(
  node: TerminalPaneLayoutNode,
  element: HTMLElement,
  gridColumnCount: number,
  dividerHitSizePx: number
): void {
  if (node.type === 'split' && node.direction === 'horizontal') {
    const [first, second] = getGridSplitContent(element)
    if (first && second) {
      applyPartialGridRowWidth(node.first, first, gridColumnCount, dividerHitSizePx)
      applyPartialGridRowWidth(node.second, second, gridColumnCount, dividerHitSizePx)
    }
    return
  }

  const rowColumnCount = gridAxisUnits(node, 'vertical')
  if (rowColumnCount >= gridColumnCount) {
    return
  }
  // Why: a percentage alone allocates divider pixels to visible cells;
  // subtracting that share keeps partial-row content equal to full-row content.
  const widthPercent = (rowColumnCount / gridColumnCount) * 100
  const dividerCorrection =
    ((gridColumnCount - rowColumnCount) / gridColumnCount) * dividerHitSizePx
  element.style.alignSelf = 'flex-start'
  element.style.width = `calc(${widthPercent}% - ${dividerCorrection}px)`
}

function buildGridDom(
  node: TerminalPaneLayoutNode,
  paneByLeafId: ReadonlyMap<string, ManagedPaneInternal>,
  styleOptions: PaneStyleOptions,
  dividerHitSizePx: number
): HTMLElement {
  if (node.type === 'leaf') {
    const pane = paneByLeafId.get(node.leafId)
    if (!pane) {
      throw new Error(`Missing mounted pane for orchestration-grid leaf ${node.leafId}`)
    }
    applyPaneFlexStyle(pane.container)
    // Why: a leaf can move out of a partial row during close reflow, so its
    // old cross-axis override must not constrain the new full row.
    pane.container.style.alignSelf = ''
    return pane.container
  }

  const isVertical = node.direction === 'vertical'
  const split = document.createElement('div')
  split.className = `pane-split ${isVertical ? 'is-vertical' : 'is-horizontal'}`
  split.style.display = 'flex'
  split.style.flexDirection = isVertical ? 'row' : 'column'
  split.style.minWidth = '0'
  split.style.minHeight = '0'
  const first = buildGridDom(node.first, paneByLeafId, styleOptions, dividerHitSizePx)
  const second = buildGridDom(node.second, paneByLeafId, styleOptions, dividerHitSizePx)
  applyGridAxisFlex(first, gridAxisUnits(node.first, node.direction), dividerHitSizePx)
  applyGridAxisFlex(second, gridAxisUnits(node.second, node.direction), dividerHitSizePx)
  split.append(first, createOrchestrationGridDivider(isVertical, styleOptions), second)
  return split
}

export function arrangeMountedPanesAsOrchestrationGrid(args: ArrangeOrchestrationGridArgs): void {
  const panes = resolveGridPaneOrder(args.panes, args.leafIds)
  if (args.leafIds) {
    // Why: later close/detach reflows have no restore hint, so keep the accepted
    // visual order in the manager's stable Map before rebuilding the DOM.
    persistGridPaneOrder(args.panes, panes)
  }
  if (panes.length === 0) {
    return
  }
  const gridRoot = buildOrchestrationTerminalGridRoot(panes.map((pane) => pane.leafId))
  if (!gridRoot) {
    return
  }
  const moved = preparePaneMoves(panes)
  const paneByLeafId = new Map(panes.map((pane) => [pane.leafId, pane]))
  const dividerHitSizePx = getDividerHitSize(args.styleOptions)
  disposeDividersIn(args.root)
  const gridElement = buildGridDom(gridRoot, paneByLeafId, args.styleOptions, dividerHitSizePx)
  applyPartialGridRowWidth(
    gridRoot,
    gridElement,
    getOrchestrationTerminalGridColumnCount(panes.length),
    dividerHitSizePx
  )
  gridElement.style.flex = ''
  gridElement.style.width = '100%'
  gridElement.style.height = '100%'
  args.root.replaceChildren(gridElement)
  applyDividerStyles(args.root, args.styleOptions)
  for (const state of moved) {
    safeFit(state.pane)
    scheduleSplitScrollRestore(
      (id) => args.panes.get(id),
      state.pane.id,
      state.scrollState,
      args.isDestroyed,
      state.shouldReattachWebgl ? reattachWebglIfNeeded : undefined
    )
  }
  args.onLayoutChanged?.()
}
