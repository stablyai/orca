let activeTabStripPointerGestureCount = 0

export function beginTabStripPointerGesture(): () => void {
  activeTabStripPointerGestureCount += 1
  let released = false

  return () => {
    if (released) {
      return
    }
    released = true
    activeTabStripPointerGestureCount = Math.max(0, activeTabStripPointerGestureCount - 1)
  }
}

export function isTabStripPointerGestureActive(): boolean {
  return activeTabStripPointerGestureCount > 0
}
