import type { DropZone, ManagedPaneInternal, PaneStyleOptions } from './pane-manager-types'
import { createDivider } from './pane-divider'
import { disposeWebgl, attachWebgl } from './pane-lifecycle'

export { findLineByContent, captureScrollState, restoreScrollState } from './pane-scroll'

// ---------------------------------------------------------------------------
// Split-tree manipulation: detach, insert, promote sibling
// ---------------------------------------------------------------------------

type TreeOpsCallbacks = {
  getRoot: () => HTMLElement
  getStyleOptions: () => PaneStyleOptions
  safeFit: (pane: ManagedPaneInternal) => void
  refitPanesUnder: (el: HTMLElement) => void
  onLayoutChanged?: () => void
}

function getProposedDimensions(pane: ManagedPaneInternal): { cols: number; rows: number } | null {
  try {
    return pane.fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}

// Why: xterm's terminal.resize() (called by fitAddon.fit()) natively preserves
// viewportY across reflows — see scroll-reflow.test.ts "reference: undisturbed".
// A plain fit() is all we need during sidebar drags, divider drags, and window
// resizes. This matches how Superset and VSCode handle the same cases.
//
// pendingSplitScrollState is the one case where fit() alone isn't enough:
// wrapInSplit() reparents the container, which makes the browser reset
// scrollTop to 0 asynchronously. splitPane captures the pre-split state and
// scheduleSplitScrollRestore owns the authoritative restore on a timer, so
// safeFit here just fits and lets the scheduled restore do its job.
export function safeFit(pane: ManagedPaneInternal): void {
  try {
    const dims = getProposedDimensions(pane)
    if (dims && dims.cols === pane.terminal.cols && dims.rows === pane.terminal.rows) {
      // Why: divider drags fire refits every frame, but most frames do not
      // cross a cell boundary. Skipping those avoids FitAddon.clear()+refresh()
      // churn, which was causing visible terminal blinking while resizing.
      return
    }
    pane.fitAddon.fit()
  } catch {
    // Container may not have dimensions yet
  }
}

export function fitAllPanesInternal(panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of panes.values()) {
    safeFit(pane)
  }
}

export function refitPanesUnder(el: HTMLElement, panes: Map<number, ManagedPaneInternal>): void {
  // If the element is a pane, refit it
  if (el.classList.contains('pane')) {
    const paneId = Number(el.dataset.paneId)
    const pane = panes.get(paneId)
    if (pane) {
      safeFit(pane)
    }
    return
  }

  // If it's a split, refit all panes inside it
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
    // Direct child of root — just remove it
    container.remove()
    return
  }

  // Find sibling (skip dividers)
  const children = Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
  const sibling = children.find((c) => c !== container) ?? null

  // Remove pane and dividers from the split
  container.remove()
  removeDividers(parent)

  // Promote sibling to replace the split container
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

  // Capture target's flex slot
  const targetFlex = targetContainer.style.flex || ''
  const targetMinW = targetContainer.style.minWidth || ''
  const targetMinH = targetContainer.style.minHeight || ''

  // Create split wrapper
  const split = document.createElement('div')
  split.className = `pane-split ${isVertical ? 'is-vertical' : 'is-horizontal'}`
  split.style.display = 'flex'
  split.style.flexDirection = isVertical ? 'row' : 'column'

  if (parent.classList.contains('pane-split')) {
    split.style.flex = targetFlex || '1 1 0%'
    split.style.minWidth = targetMinW || '0'
    split.style.minHeight = targetMinH || '0'
    // No overflow:hidden here — divider ::after lines extend beyond
    // their parent split with negative insets so intersecting dividers
    // visually connect. Individual .pane containers still clip content.
  } else {
    split.style.width = '100%'
    split.style.height = '100%'
  }

  // Create divider
  const divider = createDivider(isVertical, callbacks.getStyleOptions(), {
    refitPanesUnder: callbacks.refitPanesUnder,
    onLayoutChanged: callbacks.onLayoutChanged
  })

  // Apply flex styles to both panes
  applyPaneFlexStyle(source.container)
  applyPaneFlexStyle(targetContainer)

  // Why: same pattern as splitPane — dispose WebGL before the DOM reparent
  // to free GPU context slots, then reattach after layout settles.
  const sourceHadWebgl = !!source.webglAddon
  const targetHadWebgl = !!target.webglAddon
  disposeWebgl(source)
  disposeWebgl(target)

  // Replace target with the split in the DOM
  parent.replaceChild(split, targetContainer)

  // Build split: [first] [divider] [second]
  if (sourceFirst) {
    split.appendChild(source.container)
    split.appendChild(divider)
    split.appendChild(targetContainer)
  } else {
    split.appendChild(targetContainer)
    split.appendChild(divider)
    split.appendChild(source.container)
  }

  requestAnimationFrame(() => {
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

/** Apply standard flex styles to a pane container inside a split. */
export function applyPaneFlexStyle(el: HTMLElement): void {
  el.style.flex = '1 1 0%'
  el.style.minWidth = '0'
  el.style.minHeight = '0'
  el.style.position = 'relative'
  el.style.overflow = 'hidden'
  // Clear any fixed width/height from createInitialPane so flex sizing
  // controls the layout instead of the leftover 100% values.
  el.style.width = ''
  el.style.height = ''
}

/** Remove all divider elements from a parent element. */
export function removeDividers(parent: HTMLElement): void {
  const dividers = Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-divider')
  )
  for (const d of dividers) {
    d.remove()
  }
}

/** Find non-divider children (panes and splits) of an element. */
export function findPaneChildren(parent: HTMLElement): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

/**
 * Create a flex split wrapper that replaces `existingContainer` in the DOM,
 * then places [existing] [divider] [new] inside it.
 */
export function wrapInSplit(
  existingContainer: HTMLElement,
  newContainer: HTMLElement,
  isVertical: boolean,
  divider: HTMLElement,
  opts?: { ratio?: number }
): void {
  const parent = existingContainer.parentElement
  if (!parent) {
    return
  }

  // Capture the flex style BEFORE modifying
  const existingFlex = existingContainer.style.flex || ''
  const existingMinW = existingContainer.style.minWidth || ''
  const existingMinH = existingContainer.style.minHeight || ''

  // Create split container
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

  // Apply flex styles to both pane containers
  applyPaneFlexStyle(existingContainer)
  applyPaneFlexStyle(newContainer)

  // Apply custom ratio if provided
  const ratio = opts?.ratio
  if (ratio !== undefined && ratio > 0 && ratio < 1) {
    existingContainer.style.flex = `${ratio} 1 0%`
    newContainer.style.flex = `${1 - ratio} 1 0%`
  }

  // Replace existing with split in the DOM, then build children
  parent.replaceChild(split, existingContainer)
  split.appendChild(existingContainer)
  split.appendChild(divider)
  split.appendChild(newContainer)
}
