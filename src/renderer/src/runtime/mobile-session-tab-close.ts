import type { AppState } from '../store/types'
import { holdsTerminal } from '../../../shared/tab-types'

const EDITOR_SESSION_CONTENT_TYPES = new Set(['editor', 'diff', 'conflict-review', 'check-details'])

export function closeMobileSessionTabInStore(
  store: Pick<AppState, 'unifiedTabsByWorktree' | 'openFiles' | 'closeFile' | 'closeUnifiedTab'>,
  worktreeId: string,
  tabId: string
): boolean {
  // A terminal is named by its terminal id; the tab it sits in may keep an earlier content's id.
  const unifiedTab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) =>
    tab.contentType === 'terminal'
      ? holdsTerminal(tab, tabId)
      : tab.id === tabId || tab.entityId === tabId
  )
  if (unifiedTab && EDITOR_SESSION_CONTENT_TYPES.has(unifiedTab.contentType)) {
    store.closeFile(unifiedTab.entityId)
    return true
  }

  const fallbackFile = store.openFiles.find(
    (file) => file.worktreeId === worktreeId && file.id === tabId
  )
  if (fallbackFile) {
    // Fallback openFiles tabs can outlive unified wrappers; mobile must close the source file too.
    store.closeFile(fallbackFile.id)
    return true
  }

  // A terminal's tab closes by its own id; any other row already names its tab.
  return (
    store.closeUnifiedTab(unifiedTab?.contentType === 'terminal' ? unifiedTab.id : tabId) !== null
  )
}
