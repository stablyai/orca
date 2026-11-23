import type { AppState } from '../../types'
import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace/identity/workspace-scope'

/** Expanding sleeping rows inserts rows above the active one; the scroll anchor holds the top
 *  visible row, so without a reveal the active workspace falls out of the viewport (#47643). */
export function revealActiveWorkspaceAfterSleepingRowsExpand(
  state: Pick<
    AppState,
    'activeWorkspaceKey' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  revealWorktreeInSidebar: AppState['revealWorktreeInSidebar']
): void {
  const activeWorkspaceId = getActiveSidebarWorkspaceId(
    state.activeWorkspaceKey,
    state.activeWorktreeId
  )
  if (!activeWorkspaceId) {
    return
  }
  revealWorktreeInSidebar(activeWorkspaceId, {
    behavior: 'smooth',
    ...(state.activeWorkspaceExecutionHostId
      ? { executionHostId: state.activeWorkspaceExecutionHostId }
      : {})
  })
}
