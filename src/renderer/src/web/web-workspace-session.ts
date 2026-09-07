import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export function sanitizeWebRuntimeWorkspaceSession(
  session: WorkspaceSessionState,
  preserveEditors = false
): WorkspaceSessionState {
  const defaults = getDefaultWorkspaceSession()
  const unifiedTabs =
    preserveEditors && session.unifiedTabs
      ? Object.fromEntries(
          Object.entries(session.unifiedTabs).map(([id, tabs]) => [
            id,
            tabs.filter((tab) => tab.contentType === 'editor')
          ])
        )
      : undefined
  const tabGroups =
    unifiedTabs && session.tabGroups
      ? Object.fromEntries(
          Object.entries(session.tabGroups).map(([id, groups]) => {
            const editorIds = new Set((unifiedTabs[id] ?? []).map((tab) => tab.id))
            return [
              id,
              groups.map((group) => ({
                ...group,
                activeTabId:
                  group.activeTabId && editorIds.has(group.activeTabId) ? group.activeTabId : null,
                tabOrder: group.tabOrder.filter((tabId) => editorIds.has(tabId)),
                recentTabIds: group.recentTabIds?.filter((tabId) => editorIds.has(tabId))
              }))
            ]
          })
        )
      : undefined
  return {
    ...defaults,
    ...(preserveEditors
      ? {
          openFilesByWorktree: session.openFilesByWorktree,
          activeFileIdByWorktree: session.activeFileIdByWorktree,
          activeTabTypeByWorktree: session.activeTabTypeByWorktree,
          markdownFrontmatterVisible: session.markdownFrontmatterVisible,
          unifiedTabs,
          tabGroups,
          tabGroupLayouts: session.tabGroupLayouts,
          activeGroupIdByWorktree: session.activeGroupIdByWorktree
        }
      : {}),
    // Why: paired web clients get live tabs from the host runtime. Persisting
    // those remote handles in browser storage replays stale terminal/browser
    // selectors after a new pairing or host restart.
    activeRepoId: session.activeRepoId ?? null,
    activeWorktreeId: session.activeWorktreeId ?? null,
    browserUrlHistory: session.browserUrlHistory ?? defaults.browserUrlHistory,
    lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId
  }
}
