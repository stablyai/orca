export type ScrollToCurrentWorkspaceStatus = {
  visible: boolean
  disabled: boolean
}

export const SCROLL_TO_CURRENT_WORKSPACE_STATUS_EVENT = 'orca-scroll-to-current-workspace-status'
export const SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT =
  'orca-scroll-to-current-workspace-reveal-request'

const HIDDEN_SCROLL_TO_CURRENT_WORKSPACE_STATUS: ScrollToCurrentWorkspaceStatus = {
  visible: false,
  disabled: false
}

let latestStatus = HIDDEN_SCROLL_TO_CURRENT_WORKSPACE_STATUS

export function getLatestScrollToCurrentWorkspaceStatus(): ScrollToCurrentWorkspaceStatus {
  return latestStatus
}

export function publishScrollToCurrentWorkspaceStatus(
  status: ScrollToCurrentWorkspaceStatus
): void {
  latestStatus = status
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(
    new CustomEvent<ScrollToCurrentWorkspaceStatus>(SCROLL_TO_CURRENT_WORKSPACE_STATUS_EVENT, {
      detail: status
    })
  )
}

export function requestScrollToCurrentWorkspaceReveal(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new Event(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT))
}
