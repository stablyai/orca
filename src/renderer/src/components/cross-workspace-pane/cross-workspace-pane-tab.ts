import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { isFloatingWorkspaceId } from '../../../../shared/workspace/identity/floating-workspace-worktree'
import type { AppState } from '@/store/types'

/** Terminals only for now: chats, browsers and editors each need their own way into the pane. */
export function canShowInCrossWorkspacePane(tab: Pick<Tab, 'contentType' | 'worktreeId'>): boolean {
  return tab.contentType === 'terminal' && !isFloatingWorkspaceId(tab.worktreeId)
}

/** The tab the pane shows, from its own workspace; null while that workspace does not hold it. */
export function selectCrossWorkspacePaneTab(state: AppState): Tab | null {
  const pane = state.crossWorkspacePane
  if (!pane) {
    return null
  }
  const tab = state.unifiedTabsByWorktree[pane.worktreeId]?.find(
    (candidate) => candidate.id === pane.tabId
  )
  return tab && canShowInCrossWorkspacePane(tab) ? tab : null
}

export function isShownInCrossWorkspacePane(
  state: AppState,
  worktreeId: string,
  tabId: string | null | undefined
): boolean {
  const pane = state.crossWorkspacePane
  return pane !== null && pane.worktreeId === worktreeId && pane.tabId === tabId
}
