import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { useAppStore } from '@/store'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type { BrowserOpenResult } from './browser-link-destination'

/** Completion may focus only the browser surface the user still has selected. */
export function focusOpenedBrowserLink(result: BrowserOpenResult): void {
  const state = useAppStore.getState()
  const group = state.groupsByWorktree[result.worktreeId]?.find(
    (item) => item.id === result.groupId
  )
  const workspace = state.browserTabsByWorktree[result.worktreeId]?.find(
    (item) => item.id === result.browserWorkspaceId
  )
  if (
    (!isFloatingWorkspaceId(result.worktreeId) && state.activeWorktreeId !== result.worktreeId) ||
    state.activeGroupIdByWorktree[result.worktreeId] !== result.groupId ||
    group?.activeTabId !== result.unifiedTabId ||
    workspace?.activePageId !== result.browserPageId
  ) {
    return
  }
  state.consumeAddressBarFocusRequest(result.browserPageId)
  state.consumeAddressBarFocusRequest(result.browserWorkspaceId)
  requestBrowserFocus({ pageId: result.browserPageId, target: 'webview' })
}
