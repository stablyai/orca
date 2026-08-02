import type { AppState } from '../store/types'

const EDITOR_SESSION_CONTENT_TYPES = new Set(['editor', 'diff', 'conflict-review', 'check-details'])

export function closeMobileSessionTabInStore(
  store: Pick<AppState, 'unifiedTabsByWorktree' | 'openFiles' | 'closeFile' | 'closeUnifiedTab'>,
  worktreeId: string,
  tabId: string
): boolean {
  const unifiedTab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === tabId || tab.entityId === tabId
  )
  if (unifiedTab && EDITOR_SESSION_CONTENT_TYPES.has(unifiedTab.contentType)) {
    store.closeFile(unifiedTab.entityId)
    return true
  }

  const fallbackFile = store.openFiles.find(
    (file) => file.worktreeId === worktreeId && file.id === tabId
  )
  if (fallbackFile) {
    // Why: mobile may receive fallback file-id tabs from openFiles after the
    // unified tab wrapper has already closed; close the source file too.
    store.closeFile(fallbackFile.id)
    return true
  }

  return store.closeUnifiedTab(tabId) !== null
}
