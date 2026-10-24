import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { Worktree, WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import {
  getDefaultWorkspaceStatusId,
  getWorkspaceStatus,
  withDefaultWorkspaceStatuses
} from '../../../../shared/workspace-statuses'

/** The board status to badge on a sidebar card, or null when the badge would add nothing. */
export function resolveWorktreeCardBoardStatus(
  worktree: Pick<Worktree, 'workspaceStatus'>,
  storedStatuses: readonly WorkspaceStatusDefinition[] | undefined,
  groupBy: PersistedUIState['groupBy']
): WorkspaceStatusDefinition | null {
  // Why: grouped by status, the section header already names it.
  if (groupBy === 'workspace-status') {
    return null
  }
  // Why: partially hydrated (or test-mocked) stores can omit the list; the board shows defaults then.
  const statuses = withDefaultWorkspaceStatuses(storedStatuses ?? [])
  const statusId = getWorkspaceStatus(worktree, statuses)
  // Why: every untouched workspace sits in the default lane; badging it would clutter every card.
  if (statusId === getDefaultWorkspaceStatusId(statuses)) {
    return null
  }
  return statuses.find((status) => status.id === statusId) ?? null
}
