import type { Tab } from '../../../../../shared/tab-types'

type BrowserGuestTab = Pick<Tab, 'contentType' | 'entityId' | 'groupId'>

/**
 * The split that owns this browser workspace, or undefined while the tab is mid-move.
 * Unified browser tabs store the workspace id in `entityId`, not the live page id.
 */
export function owningGroupIdForBrowserGuest(
  tabs: readonly BrowserGuestTab[] | undefined,
  workspaceId: string
): string | undefined {
  for (const tab of tabs ?? []) {
    if (tab.contentType === 'browser' && tab.entityId === workspaceId) {
      return tab.groupId
    }
  }
  return undefined
}

/**
 * Guest webview focus does not bubble to the overlay, so Ctrl+Tab would keep
 * the previously focused split (#22144). Address-bar focus never reaches here.
 */
export function focusOwningGroupForBrowserGuest(args: {
  worktreeId: string
  workspaceId: string
  unifiedTabsByWorktree: Readonly<Record<string, readonly BrowserGuestTab[] | undefined>>
  focusGroup: (worktreeId: string, groupId: string) => void
}): void {
  const groupId = owningGroupIdForBrowserGuest(
    args.unifiedTabsByWorktree[args.worktreeId],
    args.workspaceId
  )
  if (!groupId) {
    return
  }
  args.focusGroup(args.worktreeId, groupId)
}
