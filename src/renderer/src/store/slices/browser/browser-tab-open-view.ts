import type { SessionSourceEdit, OrdinarySourcePartial } from '@/store/session-source-edits'
import type { CreateBrowserTabOptions } from './browser-slice-contract'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  ORCA_BROWSER_BLANK_URL
} from '../../../../../shared/constants'
import type { AppState } from '../../types'
import { ownsGlobalSelection } from '../../global-selection-owner'

// The window's own view of a browser tab it opens: its tab-bar order entry, browser selection and
// the address-bar focus a blank New Tab asks for; a layout-owner build writes it once drawn.
export function browserTabOpenView(
  s: AppState,
  edit: SessionSourceEdit<AppState>,
  worktreeId: string,
  browserTab: BrowserWorkspace,
  page: BrowserPage,
  options: CreateBrowserTabOptions | undefined
): OrdinarySourcePartial<AppState> {
  const workspaceId = browserTab.id
  // Without this tab: a frame may already have drawn its record.
  const existingTabs = (s.browserTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.id !== workspaceId
  )
  const nextTabBarOrder = (() => {
    const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
    const terminalIds = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    const editorIds = s.openFiles
      .filter((file) => file.worktreeId === worktreeId)
      .map((file) => file.id)
    const ids = [...terminalIds, ...editorIds, ...existingTabs.map((tab) => tab.id)]
    const allExistingIds = new Set(ids)
    const base = currentOrder.filter((entryId) => allExistingIds.has(entryId))
    const inBase = new Set(base)
    return [...base, ...[...allExistingIds].filter((entryId) => !inBase.has(entryId)), workspaceId]
  })()

  const shouldActivate = options?.activate ?? true
  const shouldUpdateGlobalActiveSurface = shouldActivate && ownsGlobalSelection(s, worktreeId)
  const shouldFocusFloatingTab = shouldActivate && worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const shouldFocusAddressBar =
    (shouldUpdateGlobalActiveSurface || shouldFocusFloatingTab) &&
    // Why the doc check and not just the url: a document page is blank by construction, and
    // the blank url is exactly what marks a New Tab as wanting the address bar it does not have.
    !page.docLocation &&
    (options?.focusAddressBar ??
      (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL))

  edit.set(
    'activeBrowserTabIdByWorktree',
    worktreeId,
    shouldActivate ? workspaceId : (s.activeBrowserTabIdByWorktree[worktreeId] ?? null)
  )
  if (shouldActivate) {
    edit.set('activeTabTypeByWorktree', worktreeId, 'browser')
  }
  return {
    tabBarOrderByWorktree: {
      ...s.tabBarOrderByWorktree,
      [worktreeId]: nextTabBarOrder
    },
    activeBrowserTabId: shouldUpdateGlobalActiveSurface ? workspaceId : s.activeBrowserTabId,
    activeTabType: shouldUpdateGlobalActiveSurface ? 'browser' : s.activeTabType,
    pendingAddressBarFocusByPageId: shouldFocusAddressBar
      ? {
          ...s.pendingAddressBarFocusByPageId,
          [page.id]: true
        }
      : s.pendingAddressBarFocusByPageId,
    pendingAddressBarFocusByTabId: shouldFocusAddressBar
      ? {
          ...s.pendingAddressBarFocusByTabId,
          [workspaceId]: true,
          [page.id]: true
        }
      : s.pendingAddressBarFocusByTabId
  }
}
