// Browser tab and page changes in a layout-owner build (phase C5). The window still draws first
// and saves its whole copy; main records each change under the window's own ids, so a later
// command naming the tab or page finds it. Nothing to undo on any answer: the window's next save
// carries the change when main cannot take it.

import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { recordLayoutApply, type sendLayoutApply } from '@/runtime/layout-apply-send'
import { drawnTabPlacement } from '@/runtime/layout-owner-drawn-tab-placement'
import type { AppState } from '../../types'

type BrowserCommandState = Parameters<typeof sendLayoutApply>[0] &
  Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'>

/** The open of a browser tab the window just drew, placed where the window drew it. */
export function recordBrowserTabOpen(state: BrowserCommandState, tab: BrowserWorkspace): void {
  const entry = browserTabEntry(state, tab.worktreeId, tab.id)
  const pageId = tab.pageIds?.[0]
  if (!entry || !pageId) {
    return
  }
  recordLayoutApply(state, tab.worktreeId, {
    type: 'openBrowserTab',
    tabId: entry.id,
    browserTabId: tab.id,
    pageId,
    profileId: tab.sessionProfileId ?? null,
    sessionPartition: tab.sessionPartition ?? null,
    // Open to the side: main makes the window's new split with the tab.
    ...drawnTabPlacement(state, tab.worktreeId, entry.groupId, entry.id),
    createdAt: entry.createdAt,
    browserCreatedAt: tab.createdAt
  })
}

/** The close of a browser tab whose tab-bar entry the window is about to remove. */
export function recordBrowserTabClose(
  state: BrowserCommandState,
  worktreeId: string,
  browserTabId: string,
  reason: 'user' | 'cleanup'
): void {
  const entry = browserTabEntry(state, worktreeId, browserTabId)
  if (entry) {
    recordLayoutApply(state, worktreeId, {
      type: 'closeTabs',
      tabIds: [entry.id],
      recordClose: reason
    })
  }
}

function browserTabEntry(state: BrowserCommandState, worktreeId: string, browserTabId: string) {
  return state.unifiedTabsByWorktree[worktreeId]?.find(
    (entry) => entry.contentType === 'browser' && entry.entityId === browserTabId
  )
}
