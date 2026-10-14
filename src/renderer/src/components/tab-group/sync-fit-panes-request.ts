import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'

let dispatchQueued = false

/**
 * Dispatches SYNC_FIT_PANES_EVENT once per microtask. Every mounted group reacts to a settings
 * toggle in the same commit, and each dispatch refits every pane, so N groups must not mean N refits.
 */
export function queueSyncFitPanes(): void {
  if (dispatchQueued) {
    return
  }
  dispatchQueued = true
  // Why: a microtask still runs before paint, so the refit lands in the same frame as the 32px change.
  queueMicrotask(() => {
    dispatchQueued = false
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  })
}
