const resumeListeners = new Set<() => void>()
let unsubscribeSystemResumed: (() => void) | null = null

function dispatchBrowserSystemResume(): void {
  for (const listener of resumeListeners) {
    try {
      listener()
    } catch (error) {
      console.error('[browser] system resume listener failed:', error)
    }
  }
}

export function subscribeBrowserSystemResume(listener: () => void): () => void {
  resumeListeners.add(listener)
  unsubscribeSystemResumed ??= window.api.ui.onSystemResumed(dispatchBrowserSystemResume)

  return () => {
    resumeListeners.delete(listener)
    if (resumeListeners.size === 0) {
      unsubscribeSystemResumed?.()
      unsubscribeSystemResumed = null
    }
  }
}
