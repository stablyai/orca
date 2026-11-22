import type { AppState } from '@/store/types'
import { findFolderWorkspaceOwner } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { projectGroupHookOwner } from '../../../../shared/workspace-setup/hooks/workspace-hook-owner'
import type {
  ArchiveHookApproval,
  ArchiveHookApprovalRequest
} from '../../../../shared/worktree/removal/archive-hook-decision'
import { decideHooksWithoutPrompt } from './ensure-hooks-confirmed'

/** Answers for another client what this window's Delete would do with the archive hook, never prompting. */
export async function answerArchiveHookApproval(
  state: AppState,
  request: ArchiveHookApprovalRequest
): Promise<ArchiveHookApproval> {
  const hostId = normalizeExecutionHostId(request.hostId)
  if (!hostId) {
    return { decision: 'undecided' }
  }
  let trustKey: string
  if ('folderWorkspaceId' in request) {
    const workspace = findFolderWorkspaceOwner(state, request.folderWorkspaceId, hostId)
    const group =
      workspace &&
      state.projectGroups.find(
        (entry) => entry.id === workspace.projectGroupId && getRepoExecutionHostId(entry) === hostId
      )
    const owner = group && projectGroupHookOwner(group)
    if (!owner) {
      return { decision: 'undecided' }
    }
    trustKey = owner.id
  } else {
    trustKey = getRepoIdFromWorktreeId(request.worktreeId)
  }
  const decided = await decideHooksWithoutPrompt(state, trustKey, 'archive', hostId)
  if (decided.kind === 'run') {
    return {
      decision: 'run',
      ...(decided.approvedContentHash ? { approvedArchiveHash: decided.approvedContentHash } : {})
    }
  }
  return { decision: decided.kind === 'needs-approval' ? 'needs-approval' : 'undecided' }
}
