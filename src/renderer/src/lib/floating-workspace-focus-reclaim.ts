// One-shot keyboard-reclaim intent for the floating workspace panel.
// A sticky boolean, NOT a focus mirror: set at close-initiation while the panel owns keyboard
// ownership *and only for a close that will empty the panel*, captured before the destructive DOM
// removal (which blurs the pane and would flip a live focus mirror to false first). The panel's
// visibleFloatingItemCount→0 effect consumes it to re-grab keyboard ownership for the next
// Cmd/Ctrl+T. Genuine outside releases (outside pointer-down, window blur to another app) clear it.
let floatingPanelReclaimIntent = false

export function armFloatingPanelReclaimIntent(): void {
  floatingPanelReclaimIntent = true
}

export function consumeFloatingPanelReclaimIntent(): boolean {
  const armed = floatingPanelReclaimIntent
  floatingPanelReclaimIntent = false
  return armed
}

export function clearFloatingPanelReclaimIntent(): void {
  floatingPanelReclaimIntent = false
}
