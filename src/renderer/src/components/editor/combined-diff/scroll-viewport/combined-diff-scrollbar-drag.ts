type CombinedDiffScrollbarDragWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>

export type CombinedDiffScrollbarDragCleanup = () => void

export type CombinedDiffScrollbarDragOptions = {
  track: HTMLElement
  pointerId: number
  onPointerMove: (event: PointerEvent) => void
  onEnd?: () => void
  ownerWindow?: CombinedDiffScrollbarDragWindow
}

export function beginCombinedDiffScrollbarDrag({
  track,
  pointerId,
  onPointerMove,
  onEnd,
  ownerWindow = window
}: CombinedDiffScrollbarDragOptions): CombinedDiffScrollbarDragCleanup {
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) {
      return
    }
    cleaned = true
    try {
      if (track.hasPointerCapture(pointerId)) {
        track.releasePointerCapture(pointerId)
      }
    } catch {
      // Best effort: unmount cleanup can run after Chromium has already dropped capture.
    }
    ownerWindow.removeEventListener('pointermove', onPointerMove)
    ownerWindow.removeEventListener('pointerup', cleanup)
    ownerWindow.removeEventListener('pointercancel', cleanup)
    track.removeEventListener('lostpointercapture', cleanup)
    onEnd?.()
  }

  track.setPointerCapture(pointerId)
  ownerWindow.addEventListener('pointermove', onPointerMove)
  ownerWindow.addEventListener('pointerup', cleanup)
  ownerWindow.addEventListener('pointercancel', cleanup)
  track.addEventListener('lostpointercapture', cleanup)

  return cleanup
}
