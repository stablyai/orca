import { useAppStore } from '@/store'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { findIndexedRepoOwnerForHost } from '@/lib/workspace/ownership/repo-owner-index'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '@/store/types'

export function projectForAgentDefault(state: AppState, repo: Repo) {
  const hostId = getRepoExecutionHostId(repo)
  const setup = state.projectHostSetups.find(
    (row) => row.repoId === repo.id && row.hostId === hostId
  )
  const projectId = setup?.projectId ?? getProjectIdentityKey(repo)
  return (
    state.projects.find((row) => row.id === projectId) ??
    state.projects.find((row) => row.sourceRepoIds.includes(repo.id))
  )
}

export function useWorkspaceAgentDefault(worktreeId: string, hostId: ExecutionHostId | undefined) {
  return useAppStore((state) => {
    if (!hostId) {
      return undefined
    }
    const worktree = findKnownWorktreeById(state, worktreeId, hostId)
    if (!worktree) {
      return undefined
    }
    const explicit =
      worktree.projectId && state.projects.find((row) => row.id === worktree.projectId)
    if (explicit) {
      return explicit
    }
    const repo = findIndexedRepoOwnerForHost(state.repos, worktree.repoId, hostId)
    return repo ? projectForAgentDefault(state, repo) : undefined
  })
}
