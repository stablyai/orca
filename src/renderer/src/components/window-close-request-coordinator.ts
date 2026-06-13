// Coordinates the single main->renderer window-close-request subscription (owned
// by the always-mounted App root) with the rich close-confirmation handler in
// Terminal, which only mounts once a workspace exists. Without this, quitting on
// the no-workspace landing page — where Terminal (and its listener) is not
// mounted — sends 'window:close-requested' to a renderer with no handler, so
// confirmWindowClose() is never called and the window never closes (#5144).

export type WindowCloseRequestHandler = (data: { isQuitting: boolean }) => void

let activeHandler: WindowCloseRequestHandler | null = null

/** Terminal registers its rich handler while mounted; passing null on unmount
 *  hands the decision back to the App-root fallback. */
export function setWindowCloseRequestHandler(handler: WindowCloseRequestHandler | null): void {
  activeHandler = handler
}

export function getWindowCloseRequestHandler(): WindowCloseRequestHandler | null {
  return activeHandler
}

/** Route a main-process close request: delegate to Terminal's rich handler when
 *  mounted, else confirm directly. Why confirm directly: with no workbench
 *  mounted there are no terminals or editor tabs to protect, so blocking would
 *  just deadlock the window (#5144). */
export function dispatchWindowCloseRequest(data: { isQuitting: boolean }): void {
  if (activeHandler) {
    activeHandler(data)
    return
  }
  window.api.ui.confirmWindowClose()
}
