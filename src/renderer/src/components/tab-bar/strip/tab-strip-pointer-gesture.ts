let activeTabStripPointerGestureCount = 0
let activeRevealTabStripPointerGestureCount = 0
const releaseListeners = new Set<() => void>()

export function onTabStripPointerGestureRelease(listener: () => void): () => void {
  releaseListeners.add(listener)
  return () => releaseListeners.delete(listener)
}

export function beginTabStripPointerGesture(revealFocusedSlotOnRelease = true): () => void {
  activeTabStripPointerGestureCount += 1
  if (revealFocusedSlotOnRelease) {
    activeRevealTabStripPointerGestureCount += 1
  }
  let released = false

  return () => {
    if (released) {
      return
    }
    released = true
    activeTabStripPointerGestureCount = Math.max(0, activeTabStripPointerGestureCount - 1)
    if (revealFocusedSlotOnRelease) {
      activeRevealTabStripPointerGestureCount = Math.max(
        0,
        activeRevealTabStripPointerGestureCount - 1
      )
    }
    if (activeTabStripPointerGestureCount === 0) {
      for (const listener of releaseListeners) {
        listener()
      }
    }
  }
}

export function holdTabStripPointerGestureUntilRelease(
  targetWindow: Window,
  pointerId: number,
  revealFocusedSlotOnRelease = true
): void {
  const releaseGesture = beginTabStripPointerGesture(revealFocusedSlotOnRelease)
  const cleanup = (): void => {
    targetWindow.removeEventListener('pointerup', finish)
    targetWindow.removeEventListener('pointercancel', finish)
    targetWindow.removeEventListener('blur', cleanup)
    releaseGesture()
  }
  const finish = (releasedEvent: PointerEvent): void => {
    if (releasedEvent.pointerId !== pointerId) {
      return
    }
    cleanup()
  }
  targetWindow.addEventListener('pointerup', finish)
  targetWindow.addEventListener('pointercancel', finish)
  targetWindow.addEventListener('blur', cleanup)
}

export function isTabStripPointerGestureActive(): boolean {
  return activeTabStripPointerGestureCount > 0
}

export function isTabStripPointerGestureRevealOnRelease(): boolean {
  return activeRevealTabStripPointerGestureCount > 0
}
