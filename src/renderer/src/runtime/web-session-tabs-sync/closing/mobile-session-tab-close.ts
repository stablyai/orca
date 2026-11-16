import type { AppState } from '../../../store/types'

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
  const exactTab = workspaceTabs.find((tab) => tab.id === tabId)
  if (exactTab) {
    return store.closeUnifiedTab(exactTab.id) !== null
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
