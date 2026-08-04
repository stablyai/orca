// Per-tab imperative handles for the floating panel's terminal panes, plus the stable ref callback
// that fills them. Generic over the handle so this stays a plain unit-testable module instead of
// pulling in TerminalPane.
export type TerminalPaneHandleRegistry<THandle> = {
  getHandle: (tabId: string) => THandle | null
  getRefCallback: (tabId: string) => (handle: THandle | null) => void
  retainOnly: (liveTabIds: Iterable<string>) => void
}

export function createTerminalPaneHandleRegistry<THandle>(): TerminalPaneHandleRegistry<THandle> {
  const handles = new Map<string, THandle>()
  const refCallbacks = new Map<string, (handle: THandle | null) => void>()

  const getRefCallback = (tabId: string): ((handle: THandle | null) => void) => {
    const cached = refCallbacks.get(tabId)
    if (cached) {
      return cached
    }
    const register = (handle: THandle | null): void => {
      if (handle) {
        handles.set(tabId, handle)
        // Re-arm: a remount (generation bump / StrictMode) can attach through a callback that
        // retainOnly already pruned, and the next render must reuse it rather than mint a new one.
        refCallbacks.set(tabId, register)
        return
      }
      // Detach drops the handle only. Dropping the callback here would delete the entry the current
      // render just wrote, so every later render would mint a fresh identity and force React to
      // detach/re-attach the pane — the exact churn this cache exists to prevent.
      handles.delete(tabId)
    }
    refCallbacks.set(tabId, register)
    return register
  }

  return {
    getHandle: (tabId) => handles.get(tabId) ?? null,
    getRefCallback,
    retainOnly: (liveTabIds) => {
      const live = new Set(liveTabIds)
      for (const tabId of refCallbacks.keys()) {
        if (!live.has(tabId)) {
          refCallbacks.delete(tabId)
        }
      }
      for (const tabId of handles.keys()) {
        if (!live.has(tabId)) {
          handles.delete(tabId)
        }
      }
    }
  }
}
