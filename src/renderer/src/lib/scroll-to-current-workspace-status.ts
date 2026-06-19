export const SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT =
  'orca-scroll-to-current-workspace-reveal-request'

export type ScrollToCurrentWorkspaceRevealRequestDetail = {
  beginRename?: boolean
}

function dispatchScrollToCurrentWorkspaceReveal(
  detail?: ScrollToCurrentWorkspaceRevealRequestDetail
): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(
    new CustomEvent(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, { detail })
  )
}

export function requestScrollToCurrentWorkspaceReveal(): void {
  dispatchScrollToCurrentWorkspaceReveal()
}

export function requestScrollToCurrentWorkspaceRevealAndRename(): void {
  dispatchScrollToCurrentWorkspaceReveal({ beginRename: true })
}
