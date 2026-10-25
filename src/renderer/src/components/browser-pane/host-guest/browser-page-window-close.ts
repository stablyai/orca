import { useAppStore } from '@/store'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { resolveBrowserWorkspaceOwner } from '@/lib/browser-workspace-source-resolution'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../../../../../shared/browser-guest-window-close'

// Why not saved: like Chrome, a restored tab no longer counts as opened by its page.
const pagesOpenedByPage = new Set<string>()

export function markBrowserPageOpenedByPage(pageId: string): void {
  pagesOpenedByPage.add(pageId)
}

export function handleGuestWindowCloseMessage(
  pageId: string,
  webview: Pick<Electron.WebviewTag, 'canGoBack' | 'canGoForward'>,
  event: Pick<Electron.IpcMessageEvent, 'channel'>
): void {
  if (event.channel !== BROWSER_GUEST_WINDOW_CLOSE_CHANNEL) {
    return
  }
  // Why: the web's rule — a script may close a tab a page opened, or one with a single history entry.
  const closable =
    pagesOpenedByPage.has(pageId) || (!webview.canGoBack() && !webview.canGoForward())
  if (!closable) {
    return
  }
  const state = useAppStore.getState()
  const owner = resolveBrowserWorkspaceOwner(state, pageId)
  if (!owner) {
    return
  }
  const tab = (state.unifiedTabsByWorktree[owner.worktreeId] ?? []).find(
    (candidate) => candidate.contentType === 'browser' && candidate.entityId === owner.workspaceId
  )
  if (tab?.isPinned) {
    return
  }
  pagesOpenedByPage.delete(pageId)
  if ((state.browserPagesByWorkspace[owner.workspaceId] ?? []).length > 1) {
    state.closeBrowserPage(pageId)
    return
  }
  // Why the tab itself: the floating panel's shortcut bridge only reaches its focused split.
  dispatchWorkspaceTabCommand({
    type: 'close',
    target: tab
      ? { kind: 'tab', worktreeId: owner.worktreeId, tabId: tab.id }
      : { kind: 'browser-source', sourceId: pageId }
  })
}
