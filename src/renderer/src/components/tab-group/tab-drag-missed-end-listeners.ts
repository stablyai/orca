/** Window-level safety net for a tab drag whose end/cancel event never arrives.
 *  Electron/dnd-kit can occasionally miss drag end; a stuck drag ref makes all
 *  later tab clicks look like drag releases. Returns the release function. */
export function installTabDragMissedEndListeners(
  onMissedEnd: () => void,
  ignoreWindowTransition: () => boolean = () => false
): () => void {
  let cleanupTimer: number | null = null

  const clearIfDndMissedEnd = (ignoreCleanup: () => boolean = () => false): void => {
    if (cleanupTimer !== null) {
      window.clearTimeout(cleanupTimer)
    }
    cleanupTimer = window.setTimeout(() => {
      cleanupTimer = null
      if (!ignoreCleanup()) {
        onMissedEnd()
      }
    }, 0)
  }

  const clearOnWindowTransition = (): void => {
    clearIfDndMissedEnd(ignoreWindowTransition)
  }

  const clearOnPointerEnd = (): void => clearIfDndMissedEnd()

  window.addEventListener('pointerup', clearOnPointerEnd)
  window.addEventListener('pointercancel', clearOnPointerEnd)
  window.addEventListener('blur', clearOnWindowTransition)
  window.addEventListener('focus', clearOnWindowTransition)

  return () => {
    if (cleanupTimer !== null) {
      window.clearTimeout(cleanupTimer)
    }
    window.removeEventListener('pointerup', clearOnPointerEnd)
    window.removeEventListener('pointercancel', clearOnPointerEnd)
    window.removeEventListener('blur', clearOnWindowTransition)
    window.removeEventListener('focus', clearOnWindowTransition)
  }
}
