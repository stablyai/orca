import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../worktree/types'
import { getWorkspaceStatus } from './workspace-statuses'

const DONE_STATUS_ID: WorkspaceStatus = 'completed'
const IN_PROGRESS_STATUS_ID: WorkspaceStatus = 'in-progress'

/** Sending a message in a Done workspace resumes work there, so its card moves back to In progress.
 *  Null: leave the status as it is (not Done, or the host has no In progress column). */
export function workspaceStatusAfterChatSend(
  worktree: Pick<Worktree, 'workspaceStatus'>,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus | null {
  if (getWorkspaceStatus(worktree, statuses) !== DONE_STATUS_ID) {
    return null
  }
  return statuses.some((status) => status.id === IN_PROGRESS_STATUS_ID)
    ? IN_PROGRESS_STATUS_ID
    : null
}
