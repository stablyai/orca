import type { PaneStyleOptions, ManagedPaneInternal } from './pane-manager-types'
import { holdPtyResizesForPaneSubtrees } from './pane-pty-resize-hold'

// ---------------------------------------------------------------------------
// Divider creation & drag-to-resize
// ---------------------------------------------------------------------------

/** Total hit area size = visible thickness + invisible padding on each side */
export function getDividerHitSize(styleOptions: PaneStyleOptions): number {
  const thickness = styleOptions.dividerThicknessPx ?? 4
  const HIT_PADDING = 3
  return thickness + HIT_PADDING * 2
}

type DividerCallbacks = {
  refitPanesUnder: (el: HTMLElement) => void
  onLayoutChanged?: () => void
}

type DividerFlexFrameScheduler = {
  schedule: (prevFlex: number, nextFlex: number) => void
  flush: () => void
  cancel: () => void
}

const dividerDragCleanups = new WeakMap<HTMLElement, () => void>()

export function createDividerFlexFrameScheduler({
  apply,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame
}: {
  apply: (prevFlex: number, nextFlex: number) => void
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
}): DividerFlexFrameScheduler {
  let frameId: number | null = null
  let pending: { prevFlex: number; nextFlex: number } | null = null

  const applyPending = (): void => {
    frameId = null
    const next = pending
    pending = null
    if (!next) {
      return
    }
    apply(next.prevFlex, next.nextFlex)
  }

  return {
    schedule(prevFlex, nextFlex) {
      pending = { prevFlex, nextFlex }
      if (frameId !== null) {
        return
      }
      frameId = requestFrame(applyPending)
    },
    flush() {
      if (frameId !== null) {
        cancelFrame(frameId)
        frameId = null
      }
      applyPending()
    },
    cancel() {
      if (frameId !== null) {
        cancelFrame(frameId)
        frameId = null
      }
      pending = null
    }
  }
}

export function createDivider(
  isVertical: boolean,
  styleOptions: PaneStyleOptions,
  callbacks: DividerCallbacks
): HTMLElement {
  const divider = document.createElement('div')
  divider.className = `pane-divider ${isVertical ? 'is-vertical' : 'is-horizontal'}`

  // Ghostty-style: the element itself is a wide transparent hit area for easy
  // grabbing. The visible line is drawn by a CSS ::after pseudo-element
  // (see main.css), so `background` on the element stays transparent.
  const hitSize = getDividerHitSize(styleOptions)
  if (isVertical) {
    divider.style.width = `${hitSize}px`
    divider.style.cursor = 'col-resize'
  } else {
    divider.style.height = `${hitSize}px`
    divider.style.cursor = 'row-resize'
  }
  divider.style.flex = 'none'
  divider.style.position = 'relative'

  attachDividerDrag(divider, isVertical, callbacks)
  return divider
}

export function disposeDivider(divider: HTMLElement): void {
  const cleanup = dividerDragCleanups.get(divider)
  if (!cleanup) {
    return
  }
  cleanup()
  dividerDragCleanups.delete(divider)
}

export function disposeDividersIn(root: HTMLElement): void {
  const dividers = root.querySelectorAll('.pane-divider')
  for (const divider of dividers) {
    disposeDivider(divider as HTMLElement)
  }
}

function attachDividerDrag(
  divider: HTMLElement,
  isVertical: boolean,
  callbacks: DividerCallbacks
): void {
  const MIN_PANE_SIZE = 50

  let dragging = false
  let didMove = false
  let startPos = 0
  let prevFlex = 0
  let nextFlex = 0
  let totalSize = 0
  let prevEl: HTMLElement | null = null
  let nextEl: HTMLElement | null = null
  let activePointerId: number | null = null
  let releasePtyResizeHold: { flush: () => void; cancel: () => void } | null = null
  const flexScheduler = createDividerFlexFrameScheduler({
    apply: (newPrev, newNext) => {
      if (!prevEl || !nextEl) {
        return
      }
      prevEl.style.flex = `${newPrev} 1 0%`
      nextEl.style.flex = `${newNext} 1 0%`
    }
  })

  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault()
    flexScheduler.cancel()
    divider.setPointerCapture(e.pointerId)
    activePointerId = e.pointerId
    divider.classList.add('is-dragging')
    dragging = true
    didMove = false

    startPos = isVertical ? e.clientX : e.clientY

    // Find previous and next pane/split siblings
    prevEl = divider.previousElementSibling as HTMLElement | null
    nextEl = divider.nextElementSibling as HTMLElement | null

    if (!prevEl || !nextEl) {
      return
    }
    // Why: shells redraw prompts on every PTY SIGWINCH. During a divider drag
    // we still fit xterm locally, but forward only the final PTY size on drop.
    releasePtyResizeHold = holdPtyResizesForPaneSubtrees([prevEl, nextEl])

    const prevRect = prevEl.getBoundingClientRect()
    const nextRect = nextEl.getBoundingClientRect()
    const prevSize = isVertical ? prevRect.width : prevRect.height
    const nextSize = isVertical ? nextRect.width : nextRect.height
    totalSize = prevSize + nextSize

    // Store current proportions as flex-basis values
    prevFlex = prevSize
    nextFlex = nextSize
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || !prevEl || !nextEl) {
      return
    }
    didMove = true

    const currentPos = isVertical ? e.clientX : e.clientY
    const delta = currentPos - startPos

    let newPrev = prevFlex + delta
    let newNext = nextFlex - delta

    // Enforce minimum pane size
    if (newPrev < MIN_PANE_SIZE) {
      newPrev = MIN_PANE_SIZE
      newNext = totalSize - MIN_PANE_SIZE
    }
    if (newNext < MIN_PANE_SIZE) {
      newNext = MIN_PANE_SIZE
      newPrev = totalSize - MIN_PANE_SIZE
    }

    // Why: pointermove can outpace paint during split resizing. Coalescing the
    // flex writes keeps drag reflow to one update per frame.
    flexScheduler.schedule(newPrev, newNext)
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (!dragging) {
      return
    }
    dragging = false
    flexScheduler.flush()
    activePointerId = null
    if (divider.hasPointerCapture(e.pointerId)) {
      divider.releasePointerCapture(e.pointerId)
    }
    divider.classList.remove('is-dragging')
    // Final refit at the exact drop position.
    if (prevEl) {
      callbacks.refitPanesUnder(prevEl)
    }
    if (nextEl) {
      callbacks.refitPanesUnder(nextEl)
    }
    releasePtyResizeHold?.flush()
    releasePtyResizeHold = null
    prevEl = null
    nextEl = null

    // Persist updated ratios after a real drag
    if (didMove) {
      callbacks.onLayoutChanged?.()
    }
  }

  // Ghostty-style: double-click divider to equalize sibling panes
  const onDoubleClick = (): void => {
    const prev = divider.previousElementSibling as HTMLElement | null
    const next = divider.nextElementSibling as HTMLElement | null
    if (!prev || !next) {
      return
    }

    prev.style.flex = '1 1 0%'
    next.style.flex = '1 1 0%'

    callbacks.refitPanesUnder(prev)
    callbacks.refitPanesUnder(next)
    callbacks.onLayoutChanged?.()
  }

  const cancelActiveDrag = (): void => {
    dragging = false
    flexScheduler.cancel()
    releasePtyResizeHold?.cancel()
    releasePtyResizeHold = null
    activePointerId = null
    prevEl = null
    nextEl = null
    divider.classList.remove('is-dragging')
  }

  const onPointerCancel = (): void => {
    cancelActiveDrag()
  }

  const onLostPointerCapture = (): void => {
    if (!dragging) {
      return
    }
    cancelActiveDrag()
  }

  divider.addEventListener('pointerdown', onPointerDown)
  divider.addEventListener('pointermove', onPointerMove)
  divider.addEventListener('pointerup', onPointerUp)
  divider.addEventListener('pointercancel', onPointerCancel)
  divider.addEventListener('lostpointercapture', onLostPointerCapture)
  divider.addEventListener('dblclick', onDoubleClick)
  dividerDragCleanups.set(divider, () => {
    flexScheduler.cancel()
    releasePtyResizeHold?.cancel()
    releasePtyResizeHold = null
    if (activePointerId !== null) {
      try {
        if (divider.hasPointerCapture(activePointerId)) {
          divider.releasePointerCapture(activePointerId)
        }
      } catch {
        // Best effort: the captured pointer may already be gone during teardown.
      }
    }
    activePointerId = null
    dragging = false
    prevEl = null
    nextEl = null
    divider.classList.remove('is-dragging')
    divider.removeEventListener('pointerdown', onPointerDown)
    divider.removeEventListener('pointermove', onPointerMove)
    divider.removeEventListener('pointerup', onPointerUp)
    divider.removeEventListener('pointercancel', onPointerCancel)
    divider.removeEventListener('lostpointercapture', onLostPointerCapture)
    divider.removeEventListener('dblclick', onDoubleClick)
  })
}

export function applyDividerStyles(root: HTMLElement, styleOptions: PaneStyleOptions): void {
  const thickness = styleOptions.dividerThicknessPx ?? 4
  const hitSize = getDividerHitSize(styleOptions)

  const dividers = root.querySelectorAll('.pane-divider')
  for (const div of dividers) {
    const el = div as HTMLElement
    const isVertical = el.classList.contains('is-vertical')
    if (isVertical) {
      el.style.width = `${hitSize}px`
    } else {
      el.style.height = `${hitSize}px`
    }
    // Store the visual thickness for the CSS ::after pseudo-element
    el.style.setProperty('--divider-thickness', `${thickness}px`)
    // Extension amount lets ::after reach the center of perpendicular
    // dividers so intersecting splits visually connect.
    el.style.setProperty('--divider-extension', `${hitSize / 2}px`)
  }
}

export function applyPaneOpacity(
  panes: Iterable<ManagedPaneInternal>,
  activePaneId: number | null,
  styleOptions: PaneStyleOptions
): void {
  const { activePaneOpacity = 1, inactivePaneOpacity = 1, opacityTransitionMs = 0 } = styleOptions

  const transition = opacityTransitionMs > 0 ? `opacity ${opacityTransitionMs}ms ease` : ''

  for (const pane of panes) {
    const isActive = pane.id === activePaneId
    pane.container.style.opacity = String(isActive ? activePaneOpacity : inactivePaneOpacity)
    pane.container.style.transition = transition
  }
}

export function applyRootBackground(root: HTMLElement, styleOptions: PaneStyleOptions): void {
  if (styleOptions.splitBackground) {
    root.style.background = styleOptions.splitBackground
  }
  if (styleOptions.paddingX !== undefined) {
    root.style.setProperty('--pane-padding-x', `${styleOptions.paddingX}px`)
  }
  if (styleOptions.paddingY !== undefined) {
    root.style.setProperty('--pane-padding-y', `${styleOptions.paddingY}px`)
  }
}
