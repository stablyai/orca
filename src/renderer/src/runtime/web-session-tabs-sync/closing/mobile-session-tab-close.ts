import type { AppState } from '../../../store/types'
import { isBotChatTab } from '@/components/bots/bot-workspace'
import {
  SESSION_TAB_CLOSE_FAILED_ERROR,
  SESSION_TAB_NOT_FOUND_ERROR
} from '../../../../../shared/workspace-layout/client-views/session-tab-close'
import { isLocalSessionTabCloseOwned } from './local-session-tab-close-owner'

const EDITOR_SESSION_CONTENT_TYPES = new Set([
  'editor',
  'diff',
  'conflict-review',
  'check-details',
  'git-graph'
])

export function closeMobileSessionTabInStore(
  store: Pick<AppState, 'unifiedTabsByWorktree' | 'openFiles' | 'closeFile' | 'closeUnifiedTab'>,
  worktreeId: string,
  tabId: string
): boolean {
  const workspaceTabs = store.unifiedTabsByWorktree[worktreeId] ?? []
  if (
    workspaceTabs.some((tab) => (tab.id === tabId || tab.entityId === tabId) && isBotChatTab(tab))
  ) {
    return false
  }
  const exactTab = workspaceTabs.find((tab) => tab.id === tabId)
  if (exactTab) {
    // Main asked for this close and closes the chat on its host itself.
    return store.closeUnifiedTab(exactTab.id, { hostRetirementHandled: true }) !== null
  }
  const fileTabs = workspaceTabs.filter(
    (tab) => tab.entityId === tabId && EDITOR_SESSION_CONTENT_TYPES.has(tab.contentType)
  )
  if (fileTabs.length > 0) {
    let closed = false
    for (const tab of fileTabs) {
      if (store.closeUnifiedTab(tab.id) !== null) {
        closed = true
      }
    }
    return closed
  }

  const fallbackFile = store.openFiles.find(
    (file) => file.worktreeId === worktreeId && file.id === tabId
  )
  if (fallbackFile) {
    // Fallback openFiles tabs can outlive unified wrappers; mobile must close the source file too.
    store.closeFile(fallbackFile.id, { placementWorkspaceId: worktreeId })
    return true
  }

  return false
}

/** Main's host close for this chat landed: its tab leaves now. Always answers, so main never waits
 *  out a timeout; a close this window started itself is already removing the tab. */
export function dropHostClosedSessionTab(
  store: Parameters<typeof closeMobileSessionTabInStore>[0],
  worktreeId: string,
  hostTabId: string,
  localTabId: string
): string | undefined {
  if (isLocalSessionTabCloseOwned(worktreeId, hostTabId)) {
    return undefined
  }
  try {
    return closeMobileSessionTabInStore(store, worktreeId, localTabId)
      ? undefined
      : SESSION_TAB_NOT_FOUND_ERROR
  } catch (error) {
    return error instanceof Error ? error.message : SESSION_TAB_CLOSE_FAILED_ERROR
  }
}
