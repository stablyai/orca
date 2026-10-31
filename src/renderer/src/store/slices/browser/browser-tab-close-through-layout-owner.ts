// Main frames drop tab/record before reply; then run window cleanup from captured drawn state for reopen history, host pages and document grants.

import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { dedupeTabOrder } from '../../../../../shared/workspace-layout/tab-order'
import type { AppState } from '../../types'
import { pickNextActiveTab } from '../tab-group-state'
import {
  getRecentlyClosedTabPosition,
  type RecentlyClosedTabPosition
} from '../recently-closed-tab-position'
import { closeContentTabThroughLayoutOwner } from '../tabs/content-tab-close-through-layout-owner'
import type { BrowserSliceGet, RemoteBrowserPageHandle } from './browser-slice-contract'

/** A browser tab as the window drew it when it asked main to close it. */
export type DrawnBrowserTab = {
  worktreeId: string
  record: BrowserWorkspace
  pages: BrowserPage[]
  handles: Record<string, RemoteBrowserPageHandle>
  /** Where it sat, for the reopen list; the frame has moved the rest on. */
  position: RecentlyClosedTabPosition | undefined
}

/** `state` with the tab's pages and host handles back as drawn, for today's close to read. */
export function withDrawnBrowserPages(state: AppState, drawn: DrawnBrowserTab): AppState {
  const { record } = drawn
  return {
    ...state,
    browserPagesByWorkspace: {
      ...state.browserPagesByWorkspace,
      [record.id]: state.browserPagesByWorkspace[record.id] ?? drawn.pages
    },
    remoteBrowserPageHandlesByPageId: {
      ...drawn.handles,
      ...state.remoteBrowserPageHandlesByPageId
    }
  }
}

/** Send close and run closeHere with captured state after frame removal. Return false without a unified entry or for paired-owned layouts so caller closes directly. */
export function closeBrowserTabThroughLayoutOwner(
  get: BrowserSliceGet,
  browserTabId: string,
  reason: 'user' | 'cleanup',
  closeHere: (drawn?: DrawnBrowserTab) => void,
  landIfEmptied?: () => boolean
): boolean {
  const state = get()
  const entry = Object.values(state.unifiedTabsByWorktree)
    .flat()
    .find((tab) => tab.contentType === 'browser' && tab.entityId === browserTabId)
  const record = entry
    ? state.browserTabsByWorktree[entry.worktreeId]?.find((tab) => tab.id === browserTabId)
    : undefined
  if (!entry || !record) {
    return false
  }
  const pages = state.browserPagesByWorkspace[browserTabId] ?? []
  const drawn: DrawnBrowserTab = {
    worktreeId: entry.worktreeId,
    record,
    pages,
    handles: Object.fromEntries(
      pages.flatMap((page) => {
        const handle = state.remoteBrowserPageHandlesByPageId[page.id]
        return handle ? [[page.id, handle] as const] : []
      })
    ),
    position: getRecentlyClosedTabPosition(state, entry.worktreeId, browserTabId)
  }
  const tabs = state.unifiedTabsByWorktree[entry.worktreeId] ?? []
  const group = state.groupsByWorktree[entry.worktreeId]?.find((g) => g.id === entry.groupId)
  const nextActiveTabId =
    group?.activeTabId === entry.id
      ? pickNextActiveTab(dedupeTabOrder(group.tabOrder), group.recentTabIds, entry.id, tabs)
      : (group?.activeTabId ?? null)
  return closeContentTabThroughLayoutOwner(get, entry, {
    nextActiveTabId,
    recordClose: reason,
    closeHere: () => closeHere(),
    closed: () => closeHere(drawn),
    ...(landIfEmptied ? { landIfEmptied } : {})
  })
}
