/** Window-level safety net for a tab drag whose end/cancel event never arrives.
 *  Electron/dnd-kit can occasionally miss drag end; a stuck drag ref makes all
 *  later tab clicks look like drag releases. Returns the release function. */
export function installTabDragMissedEndListeners(onMissedEnd: () => void): () => void {
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

  window.addEventListener('pointerup', clearIfDndMissedEnd)
  window.addEventListener('pointercancel', clearIfDndMissedEnd)
  window.addEventListener('blur', clearIfDndMissedEnd)
  window.addEventListener('focus', clearIfDndMissedEnd)

  return () => {
    if (cleanupTimer !== null) {
      window.clearTimeout(cleanupTimer)
    }
    window.removeEventListener('pointerup', clearIfDndMissedEnd)
    window.removeEventListener('pointercancel', clearIfDndMissedEnd)
    window.removeEventListener('blur', clearIfDndMissedEnd)
    window.removeEventListener('focus', clearIfDndMissedEnd)
  }
}
