// One-shot keyboard-reclaim intent for the floating workspace panel.
// A sticky boolean, NOT a focus mirror: armed when a close requested while the panel owned the
// keyboard lands and leaves the panel empty. Ownership is read at close request, before the
// destructive DOM removal blurs the pane. The panel consumes it to re-grab keyboard ownership for the
// next Cmd/Ctrl+T. Genuine outside releases (outside pointer-down, window blur to another app) clear it.
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

// Why observable: a close can land after the panel already rendered empty (an awaited save), so the
// panel re-checks when the intent arms, not only when its tab count changes.
export function subscribeFloatingPanelReclaimIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isFloatingPanelReclaimIntentArmed(): boolean {
  return floatingPanelReclaimIntent
}
