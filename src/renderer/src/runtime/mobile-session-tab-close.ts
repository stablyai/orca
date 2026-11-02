import type { AppState } from '../store/types'

const EDITOR_SESSION_CONTENT_TYPES = new Set(['editor', 'diff', 'conflict-review', 'check-details'])

/** Closes the window tab a row resolved to (`windowTabIdsByRowId`); a row naming no tab can only
 *  be a file shown without a tab wrapper, never a raw tab id. */
export function closeMobileSessionTabInStore(
  store: Pick<AppState, 'unifiedTabsByWorktree' | 'openFiles' | 'closeFile' | 'closeUnifiedTab'>,
  worktreeId: string,
  tabId: string | null,
  rowId: string
): boolean {
  const unifiedTab = tabId
    ? (store.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === tabId)
    : undefined
  if (unifiedTab && EDITOR_SESSION_CONTENT_TYPES.has(unifiedTab.contentType)) {
    store.closeFile(unifiedTab.entityId)
    return true
  }
  if (unifiedTab) {
    return store.closeUnifiedTab(unifiedTab.id) !== null
  }
  const fallbackFile = store.openFiles.find(
    (file) => file.worktreeId === worktreeId && file.id === rowId
  )
  if (fallbackFile) {
    // Fallback openFiles tabs can outlive unified wrappers; mobile must close the source file too.
    store.closeFile(fallbackFile.id)
    return true
  }
  return false
}
