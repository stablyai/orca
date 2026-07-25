import { holdPtyResizesForPaneSubtrees } from './pane-pty-resize-hold'

export type DividerCallbacks = {
  refitPanesUnder: (el: HTMLElement) => void
  onLayoutChanged?: () => void
  onDragActiveChange?: (active: boolean) => void
}

type DividerFlexFrameScheduler = {
  schedule: (prevFlex: number, nextFlex: number) => void
  flush: () => void
  cancel: () => void
}

const MIN_PANE_SIZE = 50
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

export function attachDividerDrag(
  divider: HTMLElement,
  isVertical: boolean,
  callbacks: DividerCallbacks
): void {
  let dragging = false
  let didMove = false
  let startPos = 0
  let prevFlex = 0
  let totalSize = 0
  let prevEl: HTMLElement | null = null
  let nextEl: HTMLElement | null = null
  let prevInitialFlex = ''
  let nextInitialFlex = ''
  let activePointerId: number | null = null
  let releasePtyResizeHold: { flush: () => void; cancel: () => void } | null = null
  let windowListenersAttached = false
  const flexScheduler = createDividerFlexFrameScheduler({
    apply: (newPrev, newNext) => {
      if (!prevEl || !nextEl) {
        return
      }
      prevEl.style.flex = `${newPrev} 1 0%`
      nextEl.style.flex = `${newNext} 1 0%`
    }
  })

  const addWindowListeners = (): void => {
    if (windowListenersAttached || typeof window === 'undefined') {
      return
    }
    // Why: Chromium can transiently lose capture while the button remains held,
    // so window events keep ownership until pointerup, pointercancel, or blur.
    windowListenersAttached = true
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('blur', onWindowBlur, true)
  }

  const removeWindowListeners = (): void => {
    if (!windowListenersAttached || typeof window === 'undefined') {
      return
    }
    windowListenersAttached = false
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('blur', onWindowBlur, true)
  }

  const releasePointerCaptureIfHeld = (pointerId: number | null): void => {
    if (pointerId === null) {
      return
    }
    try {
      if (divider.hasPointerCapture(pointerId)) {
        divider.releasePointerCapture(pointerId)
      }
    } catch {
      // Best effort: capture may already be gone after crossing native chrome/webviews.
    }
  }

  const finishActiveDrag = (commitLayout: boolean): void => {
    if (!dragging) {
      removeWindowListeners()
      releasePointerCaptureIfHeld(activePointerId)
      activePointerId = null
      return
    }

    const pointerId = activePointerId
    dragging = false
    activePointerId = null
    removeWindowListeners()

    if (commitLayout) {
      flexScheduler.flush()
    } else {
      flexScheduler.cancel()
      if (didMove && prevEl && nextEl) {
        prevEl.style.flex = prevInitialFlex
        nextEl.style.flex = nextInitialFlex
      }
    }

    releasePointerCaptureIfHeld(pointerId)
    divider.classList.remove('is-dragging')
    callbacks.onDragActiveChange?.(false)

    const shouldRefit = didMove || commitLayout
    if (shouldRefit && prevEl) {
      callbacks.refitPanesUnder(prevEl)
    }
    if (shouldRefit && nextEl) {
      callbacks.refitPanesUnder(nextEl)
    }
    if (commitLayout && shouldRefit) {
      releasePtyResizeHold?.flush()
    } else {
      releasePtyResizeHold?.cancel()
    }
    releasePtyResizeHold = null
    prevEl = null
    nextEl = null
    prevInitialFlex = ''
    nextInitialFlex = ''

    if (didMove && commitLayout) {
      callbacks.onLayoutChanged?.()
    }
    didMove = false
  }

  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault()
    flexScheduler.cancel()
    finishActiveDrag(false)
    const previousPane = divider.previousElementSibling as HTMLElement | null
    const nextPane = divider.nextElementSibling as HTMLElement | null
    if (!previousPane || !nextPane) {
      return
    }

    const prevRect = previousPane.getBoundingClientRect()
    const nextRect = nextPane.getBoundingClientRect()
    const prevSize = isVertical ? prevRect.width : prevRect.height
    const nextSize = isVertical ? nextRect.width : nextRect.height
    const measuredTotalSize = prevSize + nextSize
    if (!Number.isFinite(measuredTotalSize) || measuredTotalSize <= 0) {
      return
    }

    divider.setPointerCapture(e.pointerId)
    activePointerId = e.pointerId
    divider.classList.add('is-dragging')
    dragging = true
    didMove = false
    callbacks.onDragActiveChange?.(true)
    addWindowListeners()

    startPos = isVertical ? e.clientX : e.clientY
    prevEl = previousPane
    nextEl = nextPane
    prevInitialFlex = prevEl.style.flex
    nextInitialFlex = nextEl.style.flex

    // Why: shells redraw prompts on every PTY SIGWINCH. During a divider drag
    // we still fit xterm locally, but forward only the final PTY size on drop.
    releasePtyResizeHold = holdPtyResizesForPaneSubtrees([prevEl, nextEl])

    totalSize = measuredTotalSize
    prevFlex = prevSize
  }

  // Why: WSLg's RDP input path reports press/release as a `mouse` pointer but
  // streams motion as a `pen` pointer with a different pointerId, so a strict
  // pointerId match drops every move. Any primary pointer continues the drag.
  const isActiveDragPointer = (e: PointerEvent): boolean =>
    e.pointerId === activePointerId || e.isPrimary

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || !isActiveDragPointer(e) || !prevEl || !nextEl) {
      return
    }
    didMove = true

    const currentPos = isVertical ? e.clientX : e.clientY
    const delta = currentPos - startPos

    const effectiveMinPaneSize = Math.min(MIN_PANE_SIZE, totalSize / 2)
    const maxPrev = totalSize - effectiveMinPaneSize
    // Why: tiny restored/SSH layouts can be smaller than two minimum panes;
    // clamping both sides to 50px there would create invalid negative flex.
    const newPrev = Math.min(Math.max(prevFlex + delta, effectiveMinPaneSize), maxPrev)
    const newNext = totalSize - newPrev

    // Why: pointermove can outpace paint during split resizing. Coalescing the
    // flex writes keeps drag reflow to one update per frame.
    flexScheduler.schedule(newPrev, newNext)
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (isActiveDragPointer(e)) {
      finishActiveDrag(true)
    }
  }

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

  const onPointerCancel = (e: PointerEvent): void => {
    if (isActiveDragPointer(e)) {
      finishActiveDrag(false)
    }
  }

  const onWindowBlur = (): void => {
    finishActiveDrag(false)
  }

  divider.addEventListener('pointerdown', onPointerDown)
  divider.addEventListener('pointermove', onPointerMove)
  divider.addEventListener('pointerup', onPointerUp)
  divider.addEventListener('pointercancel', onPointerCancel)
  divider.addEventListener('dblclick', onDoubleClick)
  dividerDragCleanups.set(divider, () => {
    finishActiveDrag(false)
    divider.removeEventListener('pointerdown', onPointerDown)
    divider.removeEventListener('pointermove', onPointerMove)
    divider.removeEventListener('pointerup', onPointerUp)
    divider.removeEventListener('pointercancel', onPointerCancel)
    divider.removeEventListener('dblclick', onDoubleClick)
  })
}

export function disposeDividerDrag(divider: HTMLElement): void {
  const cleanup = dividerDragCleanups.get(divider)
  if (!cleanup) {
    return
  }
  cleanup()
  dividerDragCleanups.delete(divider)
}
