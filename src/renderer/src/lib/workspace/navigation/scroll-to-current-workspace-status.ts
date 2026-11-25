export const SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT =
  'orca-scroll-to-current-workspace-reveal-request'

export type ScrollToCurrentWorkspaceRevealRequestDetail =
  | {
      target?: { type: 'active-workspace' }
      beginRename?: boolean
      /** False: scroll to the row without its glow, as an activation's reveal does. */
      highlight?: boolean
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

export function requestScrollToCurrentWorkspaceReveal(options?: { highlight?: boolean }): void {
  dispatchScrollToCurrentWorkspaceReveal(
    options?.highlight === false
      ? { target: { type: 'active-workspace' }, highlight: false }
      : undefined
  )
}

export function requestScrollToCurrentWorkspaceRevealAndRename(): void {
  dispatchScrollToCurrentWorkspaceReveal({
    target: { type: 'active-workspace' },
    beginRename: true
  })
}
