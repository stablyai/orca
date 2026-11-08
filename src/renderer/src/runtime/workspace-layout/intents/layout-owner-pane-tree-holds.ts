const heldTabs = new Map<string, number>()

const redrawListeners = new Set<(tabId: string) => void>()

/** Keeps the tab's drawn tree from frames until the release; releasing twice is a no-op. */
export function holdTabPaneTree(tabId: string): () => void {
  heldTabs.set(tabId, (heldTabs.get(tabId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const count = (heldTabs.get(tabId) ?? 1) - 1
    if (count > 0) {
      heldTabs.set(tabId, count)
      return
    }
    heldTabs.delete(tabId)
    requestTabPaneTreeRedraw(tabId)
  }
}

/** Shows main's tree for the tab again, as the frames hold it: after a hold, or a zoom ends. */
export function requestTabPaneTreeRedraw(tabId: string): void {
  for (const listener of redrawListeners) {
    listener(tabId)
  }
}

export function isTabPaneTreeHeld(tabId: string): boolean {
  return heldTabs.has(tabId)
}

export function onTabPaneTreeRedraw(listener: (tabId: string) => void): () => void {
  redrawListeners.add(listener)
  return () => redrawListeners.delete(listener)
}

export function _resetLayoutOwnerPaneTreeHoldsForTests(): void {
  heldTabs.clear()
  redrawListeners.clear()
}
