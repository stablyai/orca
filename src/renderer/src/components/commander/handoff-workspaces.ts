import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  getProjectIdentityKey,
  isHostLocalProjectId
} from '../../../../shared/project/host-setup/project-host-setup-projection'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { automationWorktreesForRepo } from '../automations/listing/automation-list-row-identity'

export type WorkerHandoffDestination = {
  agent: 'codex' | 'claude'
  hostId: ExecutionHostId
  worktreeId: string
  instanceId?: string
}

export function handoffWorkspaces(
  projectId: string,
  hostId: ExecutionHostId,
  repos: readonly Repo[],
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
): Worktree[] {
  if (isHostLocalProjectId(projectId)) {
    return []
  }
  return repos.flatMap((repo) =>
    getRepoExecutionHostId(repo) === hostId && getProjectIdentityKey(repo) === projectId
      ? automationWorktreesForRepo(worktreesByRepo[repo.id] ?? [], repo, repos).filter(
          (wt) => !wt.isArchived && !wt.isBare && !wt.prunable && !wt.removing && !wt.removalError
        )
      : []
  )
}
