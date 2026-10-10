export const SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT =
  'orca-scroll-to-current-workspace-reveal-request'

export const SIDEBAR_PROJECT_GROUP_CREATE_REQUEST_EVENT =
  'orca-sidebar-project-group-create-request'

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

/** Opens the sidebar's standalone project-group dialog. Rides a window event so the
 *  header menu (outside WorktreeList) can reach the dialog host inside it. */
export function requestSidebarProjectGroupCreation(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_PROJECT_GROUP_CREATE_REQUEST_EVENT))
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
