// Validated guest IPC synchronously dispatches panel events because browser keystrokes bypass DOM; shared close handlers record reclaim before webview teardown.
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
