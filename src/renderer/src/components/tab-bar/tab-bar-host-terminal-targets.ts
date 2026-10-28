import type { AppState } from '@/store/types'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { selectKnownWorktreeById } from '@/store/selectors'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProjectHostSetupForRepo } from '../../../../shared/project-host-setup-lookup'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'

type HostedWorktree = Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId' | 'repoId'>

export function isWorktreeOwnHost(
  hostId: ExecutionHostId,
  worktree: HostedWorktree,
  repo: Repo | undefined
): boolean {
  // Why resolved: SSH worktree rows often lack hostId, which the alias check reads as local.
  const resolvedHostId = getWorktreeExecutionHostId(worktree, repo)
  return isExecutionHostAliasForWorktree(hostId, { ...worktree, hostId: resolvedHostId })
}

export function getWorktreeProjectId(
  worktree: Pick<Worktree, 'projectId'>,
  repo: Repo | undefined,
  projectHostSetups: readonly ProjectHostSetup[]
): string | null {
  if (worktree.projectId) {
    return worktree.projectId
  }
  return repo ? getProjectHostSetupForRepo(projectHostSetups, repo).projectId : null
}

export function isLocalHostTerminalSource(state: AppState, worktreeId: string): boolean {
  const source = selectKnownWorktreeById(state, worktreeId)
  return Boolean(
    source &&
    !source.runtimeOwnerEnvironmentId?.trim() &&
    getResolvedExecutionHostIdForWorktree(state, worktreeId) === 'local'
  )
}
