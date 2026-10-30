import type {
  DropZone,
  ManagedPane,
  ManagedPaneInternal,
  PaneStyleOptions
} from './pane-manager-types'
import { createDivider, disposeDivider } from './pane-divider'
import { disposeWebgl, attachWebgl } from './pane-webgl-renderer'
import { safeFit } from './pane-fit'

export {
  cancelPendingSafeFitContinuations,
  safeFit,
  safeFitAndThen,
  type SafeFitContinuationHandle
} from './pane-fit'
export { captureScrollState, restoreScrollState } from './pane-scroll'
export { equalizePaneSplitSizes, findPaneChildren } from './pane-tree-equalization'

type TreeOpsCallbacks = {
  getRoot: () => HTMLElement
  getStyleOptions: () => PaneStyleOptions
  safeFit: (pane: ManagedPane) => void
  refitPanesUnder: (el: HTMLElement) => void
  onLayoutChanged?: () => void
  onDragActiveChange?: (active: boolean) => void
  onDividerRatiosCommitted?: () => void
  isDestroyed?: () => boolean
  requestPaneReparentFrame?: (callback: FrameRequestCallback) => void
}

export function fitAllPanesInternal(panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of panes.values()) {
    safeFit(pane)
  }
}

export function refitPanesUnder(el: HTMLElement, panes: Map<number, ManagedPaneInternal>): void {
  if (el.classList.contains('pane')) {
    const paneId = Number(el.dataset.paneId)
    const pane = panes.get(paneId)
    if (pane) {
      safeFit(pane)
    }
    return
  }

  if (el.classList.contains('pane-split')) {
    const paneEls = el.querySelectorAll('.pane[data-pane-id]')
    for (const paneEl of paneEls) {
      const paneId = Number((paneEl as HTMLElement).dataset.paneId)
      const pane = panes.get(paneId)
      if (pane) {
        safeFit(pane)
      }
    }
  }
}

/**
 * Detach a pane's container from the split tree without disposing the terminal.
 * The sibling is promoted to take the split container's slot.
 */
export function detachPaneFromTree(pane: ManagedPaneInternal, callbacks: TreeOpsCallbacks): void {
  const container = pane.container
  const parent = container.parentElement
  if (!parent) {
    return
  }

  if (!parent.classList.contains('pane-split')) {
    container.remove()
    return
  }

  const children = Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
  const sibling = children.find((c) => c !== container) ?? null

  container.remove()
  removeDividers(parent)

  promoteSibling(sibling, parent, callbacks.getRoot())
}

/** Insert source pane next to target pane by wrapping target in a new split. */
export function insertPaneNextTo(
  source: ManagedPaneInternal,
  target: ManagedPaneInternal,
  zone: DropZone,
  callbacks: TreeOpsCallbacks
): void {
  const targetContainer = target.container
  const parent = targetContainer.parentElement
  if (!parent) {
    return
  }

  const isVertical = zone === 'left' || zone === 'right'
  const sourceFirst = zone === 'left' || zone === 'top'

  const targetFlex = targetContainer.style.flex || ''
  const targetMinW = targetContainer.style.minWidth || ''
  const targetMinH = targetContainer.style.minHeight || ''

  const split = document.createElement('div')
  split.className = `pane-split ${isVertical ? 'is-vertical' : 'is-horizontal'}`
  split.style.display = 'flex'
  split.style.flexDirection = isVertical ? 'row' : 'column'

  if (parent.classList.contains('pane-split')) {
    split.style.flex = targetFlex || '1 1 0%'
    split.style.minWidth = targetMinW || '0'
    split.style.minHeight = targetMinH || '0'
    // Keep split overflow visible so negative divider ::after insets connect intersections; individual panes still clip.
  } else {
    split.style.width = '100%'
    split.style.height = '100%'
  }

  const divider = createDivider(isVertical, callbacks.getStyleOptions(), {
    refitPanesUnder: callbacks.refitPanesUnder,
    onLayoutChanged: callbacks.onLayoutChanged,
    onDragActiveChange: callbacks.onDragActiveChange,
    onDividerRatiosCommitted: callbacks.onDividerRatiosCommitted
  })

  applyPaneFlexStyle(source.container)
  applyPaneFlexStyle(targetContainer)

  // Dispose WebGL before reparenting to free GPU slots; reattach after layout settles, as splitPane does.
  const sourceHadWebgl = !!source.webglAddon
  const targetHadWebgl = !!target.webglAddon
  disposeWebgl(source)
  disposeWebgl(target)

  parent.replaceChild(split, targetContainer)

  if (sourceFirst) {
    split.appendChild(source.container)
    split.appendChild(divider)
    split.appendChild(targetContainer)
  } else {
    split.appendChild(targetContainer)
    split.appendChild(divider)
    split.appendChild(source.container)
  }

  const requestReparentFrame =
    callbacks.requestPaneReparentFrame ??
    ((callback: FrameRequestCallback) => requestAnimationFrame(callback))
  requestReparentFrame(() => {
    if (callbacks.isDestroyed?.()) {
      return
    }
    if (sourceHadWebgl && source.gpuRenderingEnabled && !source.webglDisabledAfterContextLoss) {
      attachWebgl(source)
    }
    if (targetHadWebgl && target.gpuRenderingEnabled && !target.webglDisabledAfterContextLoss) {
      attachWebgl(target)
    }
    callbacks.safeFit(source)
    callbacks.safeFit(target)
  })
}

/**
 * Promote a sibling element to replace its parent split container.
 * Used when a pane is removed and the split wrapper becomes unnecessary.
 */
export function promoteSibling(
  sibling: HTMLElement | null,
  parent: HTMLElement,
  root: HTMLElement
): void {
  if (sibling) {
    const grandparent = parent.parentElement
    if (grandparent) {
      if (grandparent === root) {
        sibling.style.flex = ''
        sibling.style.minWidth = ''
        sibling.style.minHeight = ''
        sibling.style.width = '100%'
        sibling.style.height = '100%'
        sibling.style.position = 'relative'
        sibling.style.overflow = 'hidden'
      } else if (grandparent.classList.contains('pane-split')) {
        sibling.style.flex = parent.style.flex || '1 1 0%'
        sibling.style.minWidth = parent.style.minWidth || '0'
        sibling.style.minHeight = parent.style.minHeight || '0'
        sibling.style.overflow = 'hidden'
      }
      grandparent.replaceChild(sibling, parent)
    }
  } else {
    parent.remove()
  }
}

export function applyPaneFlexStyle(el: HTMLElement): void {
  el.style.flex = '1 1 0%'
  el.style.minWidth = '0'
  el.style.minHeight = '0'
  el.style.position = 'relative'
  el.style.overflow = 'hidden'
  // Remove initial 100% dimensions so flex controls layout.
  el.style.width = ''
  el.style.height = ''
}

export function removeDividers(parent: HTMLElement): void {
  const dividers = Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-divider')
  )
  for (const d of dividers) {
    disposeDivider(d)
    d.remove()
  }
}

/**
 * Create a flex split wrapper that replaces `existingContainer` in the DOM,
 * then places [existing] [divider] [new] inside it ([new] first when `newPaneFirst`).
 */
export function wrapInSplit(
  existingContainer: HTMLElement,
  newContainer: HTMLElement,
  isVertical: boolean,
  divider: HTMLElement,
  opts?: { ratio?: number; newPaneFirst?: boolean }
): void {
  const parent = existingContainer.parentElement
  if (!parent) {
    return
  }

  const existingFlex = existingContainer.style.flex || ''
  const existingMinW = existingContainer.style.minWidth || ''
  const existingMinH = existingContainer.style.minHeight || ''

  const split = document.createElement('div')
  split.className = `pane-split ${isVertical ? 'is-vertical' : 'is-horizontal'}`
  split.style.display = 'flex'
  split.style.flexDirection = isVertical ? 'row' : 'column'

  if (parent.classList.contains('pane-split')) {
    split.style.flex = existingFlex || '1 1 0%'
    split.style.minWidth = existingMinW || '0'
    split.style.minHeight = existingMinH || '0'
  } else {
    split.style.width = '100%'
    split.style.height = '100%'
  }

  applyPaneFlexStyle(existingContainer)
  applyPaneFlexStyle(newContainer)

  const ratio = opts?.ratio
  if (ratio !== undefined && ratio > 0 && ratio < 1) {
    existingContainer.style.flex = `${ratio} 1 0%`
    newContainer.style.flex = `${1 - ratio} 1 0%`
  }

  parent.replaceChild(split, existingContainer)
  if (opts?.newPaneFirst) {
    split.append(newContainer, divider, existingContainer)
  } else {
    split.append(existingContainer, divider, newContainer)
  }
}
