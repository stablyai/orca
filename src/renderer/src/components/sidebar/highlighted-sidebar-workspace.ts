import type { AppState } from '@/store/types'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace/identity/workspace-scope'

/** The workspace the sidebar presents as current: none while a full-page view or the Agent Dashboard owns that row (#41861). */
export function selectHighlightedSidebarWorkspaceId(s: AppState): string | null {
  return s.activeView === 'tasks' || s.activeView === 'activity' || s.agentDashboardDrawerOpen
    ? null
    : getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
}
