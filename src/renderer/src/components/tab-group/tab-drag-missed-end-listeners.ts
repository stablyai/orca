/** Window-level safety net for a tab drag whose end/cancel event never arrives.
 *  Electron/dnd-kit can occasionally miss drag end; a stuck drag ref makes all
 *  later tab clicks look like drag releases. Returns the release function. */
export function installTabDragMissedEndListeners(
  onMissedEnd: () => void,
  targetWindow?: Window | null
): () => void {
  let cleanupTimer: number | null = null

  const clearIfDndMissedEnd = (): void => {
    if (cleanupTimer !== null) {
      window.clearTimeout(cleanupTimer)
    }
    cleanupTimer = window.setTimeout(() => {
      cleanupTimer = null
      onMissedEnd()
    }, 0)
  }

  const handlePointerMove = (event: PointerEvent): void => {
    if (event.buttons === 0 || (event.buttons & 1) === 0) {
      clearIfDndMissedEnd()
    }
  }

  const windows: Window[] = []
  if (typeof window !== 'undefined') {
    windows.push(window)
  }
  if (targetWindow && targetWindow !== window && !windows.includes(targetWindow)) {
    windows.push(targetWindow)
  }

  for (const win of windows) {
    win.addEventListener('pointerup', clearIfDndMissedEnd)
    win.addEventListener('pointercancel', clearIfDndMissedEnd)
    win.addEventListener('blur', clearIfDndMissedEnd)
    win.addEventListener('focus', clearIfDndMissedEnd)
    win.addEventListener('pointermove', handlePointerMove)
    try {
      win.document?.addEventListener('visibilitychange', clearIfDndMissedEnd)
    } catch {
      // guard closed or inaccessible document
    }
  }

  return () => {
    if (cleanupTimer !== null) {
      window.clearTimeout(cleanupTimer)
    }
    for (const win of windows) {
      try {
        win.removeEventListener('pointerup', clearIfDndMissedEnd)
        win.removeEventListener('pointercancel', clearIfDndMissedEnd)
        win.removeEventListener('blur', clearIfDndMissedEnd)
        win.removeEventListener('focus', clearIfDndMissedEnd)
        win.removeEventListener('pointermove', handlePointerMove)
        win.document?.removeEventListener('visibilitychange', clearIfDndMissedEnd)
      } catch {
        // Window may have closed
      }
    }
  }
}
