export const SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT =
  'orca-scroll-to-current-workspace-reveal-request'

export type ScrollToCurrentWorkspaceRevealRequestDetail =
  | {
      target?: { type: 'active-workspace' }
      beginRename?: boolean
    }
  | {
      target: { type: 'sidebar-row'; rowKey: string }
      highlight?: boolean
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
  dispatchScrollToCurrentWorkspaceReveal({
    target: { type: 'active-workspace' },
    beginRename: true
  })
}
