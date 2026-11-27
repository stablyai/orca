let activeTabStripPointerGestureCount = 0
const releaseListeners = new Set<() => void>()

export function onTabStripPointerGestureRelease(listener: () => void): () => void {
  releaseListeners.add(listener)
  return () => releaseListeners.delete(listener)
}

export function beginTabStripPointerGesture(): () => void {
  activeTabStripPointerGestureCount += 1
  let released = false

  return () => {
    if (released) {
      return
    }
    released = true
    activeTabStripPointerGestureCount = Math.max(0, activeTabStripPointerGestureCount - 1)
    if (activeTabStripPointerGestureCount === 0) {
      for (const listener of releaseListeners) {
        listener()
      }
    }
  }
}

export function isTabStripPointerGestureActive(): boolean {
  return activeTabStripPointerGestureCount > 0
}
