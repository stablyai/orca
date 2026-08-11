// Guest → mounted-panel bridge for the floating workspace.
// A focused floating *browser* guest's keystrokes never reach the renderer DOM; the main-process
// guest before-input-event routes them over IPC to useIpcEvents, which (after validating the
// source id) re-dispatches them as these typed window events so the mounted panel handles the
// close/select through the exact same closures the keyboard path uses. Dispatch is synchronous,
// so the reclaim intent set inside the panel's close handler still lands before webview teardown.
export const FLOATING_WORKSPACE_GUEST_CLOSE_EVENT = 'orca:floating-workspace-guest-close'
export const FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT =
  'orca:floating-workspace-guest-select-index'

export type FloatingWorkspaceGuestCloseDetail = {
  /** The floating browser guest's owning source page id (Tab.entityId). */
  sourceId: string
}

export type FloatingWorkspaceGuestSelectIndexDetail = {
  /** Zero-based index of the visible floating tab to select. */
  index: number
}

export function dispatchFloatingWorkspaceGuestClose(
  detail: FloatingWorkspaceGuestCloseDetail
): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT, { detail }))
}

export function dispatchFloatingWorkspaceGuestSelectIndex(
  detail: FloatingWorkspaceGuestSelectIndexDetail
): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT, { detail }))
}
