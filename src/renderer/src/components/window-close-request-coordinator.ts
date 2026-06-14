// Coordinates the single main->renderer window-close-request subscription (owned
// by the always-mounted App root) with the rich close-confirmation handler in
// Terminal, which only mounts once a workspace exists. Without this, quitting on
// the no-workspace landing page — where Terminal (and its listener) is not
// mounted — sends 'window:close-requested' to a renderer with no handler, so
// confirmWindowClose() is never called and the window never closes (#5144).
//
// It also runs pre-close guards: surfaces with unsaved work (e.g. the Settings
// Git AI Author prompt editors) register a guard so quitting prompts the user to
// save/discard instead of being silently vetoed by a beforeunload handler.

export type WindowCloseRequestHandler = (data: { isQuitting: boolean }) => void

/** Returns true to allow the close to proceed, false to cancel it (e.g. the user
 *  picked "Cancel" in an unsaved-changes prompt). */
export type WindowCloseGuard = () => boolean | Promise<boolean>

let activeHandler: WindowCloseRequestHandler | null = null
const closeGuards = new Set<WindowCloseGuard>()
// Why: a guard can await a dialog; ignore re-entrant close requests (main resends
// 'window:close-requested' on each attempt) so we don't stack duplicate prompts.
let closeInFlight = false

/** Terminal registers its rich handler while mounted; passing null on unmount
 *  hands the decision back to the App-root fallback. */
export function setWindowCloseRequestHandler(handler: WindowCloseRequestHandler | null): void {
  activeHandler = handler
}

export function getWindowCloseRequestHandler(): WindowCloseRequestHandler | null {
  return activeHandler
}

/** Register a pre-close guard. Returns an unregister function for effect cleanup. */
export function registerWindowCloseGuard(guard: WindowCloseGuard): () => void {
  closeGuards.add(guard)
  return () => {
    closeGuards.delete(guard)
  }
}

async function runWindowCloseGuards(): Promise<boolean> {
  for (const guard of closeGuards) {
    if (!(await guard())) {
      return false
    }
  }
  return true
}

/** Route a main-process close request: run pre-close guards first (cancel if any
 *  vetoes), then delegate to Terminal's rich handler when mounted, else confirm
 *  directly. Why confirm directly: with no workbench mounted there are no
 *  terminals or editor tabs to protect, so blocking would just deadlock the
 *  window (#5144). */
export async function dispatchWindowCloseRequest(data: { isQuitting: boolean }): Promise<void> {
  if (closeInFlight) {
    return
  }
  closeInFlight = true
  try {
    if (!(await runWindowCloseGuards())) {
      return
    }
  } finally {
    closeInFlight = false
  }
  if (activeHandler) {
    activeHandler(data)
    return
  }
  window.api.ui.confirmWindowClose()
}
