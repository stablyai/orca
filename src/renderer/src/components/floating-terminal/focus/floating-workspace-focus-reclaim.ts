// Capture keyboard ownership before close removes DOM; if the panel empties, reclaim for the next Cmd/Ctrl+T. Clear on genuine outside release rather than mirroring transient blur.
let floatingPanelReclaimIntent = false
const listeners = new Set<() => void>()

function setFloatingPanelReclaimIntent(next: boolean): void {
  if (floatingPanelReclaimIntent === next) {
    return
  }
  floatingPanelReclaimIntent = next
  for (const listener of listeners) {
    listener()
  }
}

export function armFloatingPanelReclaimIntent(): void {
  setFloatingPanelReclaimIntent(true)
}

export function consumeFloatingPanelReclaimIntent(): boolean {
  const armed = floatingPanelReclaimIntent
  setFloatingPanelReclaimIntent(false)
  return armed
}

export function clearFloatingPanelReclaimIntent(): void {
  setFloatingPanelReclaimIntent(false)
}

// Observe late close completion too: an awaited save can arm intent after the panel already rendered empty.
export function subscribeFloatingPanelReclaimIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isFloatingPanelReclaimIntentArmed(): boolean {
  return floatingPanelReclaimIntent
}
