import type { AppState } from '@/store/types'
import type { BrowserPage } from '../../../shared/browser-workspace-types'

export function findWorkspaceShowingPage(
  state: AppState,
  worktreeId: string,
  matches: (page: BrowserPage) => boolean,
  targetGroupId?: string
): { workspaceId: string; pageId: string } | null {
  for (const tab of state.browserTabsByWorktree[worktreeId] ?? []) {
    if (
      targetGroupId &&
      !state.unifiedTabsByWorktree[worktreeId]?.some(
        (candidate) =>
          candidate.contentType === 'browser' &&
          candidate.entityId === tab.id &&
          candidate.groupId === targetGroupId
      )
    ) {
      continue
    }
    const page = (state.browserPagesByWorkspace[tab.id] ?? []).find(matches)
    if (page) {
      return { workspaceId: tab.id, pageId: page.id }
    }
  }
  return null
}
