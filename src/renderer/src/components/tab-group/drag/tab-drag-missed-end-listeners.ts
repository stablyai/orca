/** Recover missed Electron/dnd-kit drag endings so stale drag state cannot consume later clicks; return cleanup. */
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
