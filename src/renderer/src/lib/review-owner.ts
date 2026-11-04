import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { findIndexedReviewRepository, hasIndexedRepository } from './repository-owner-index'

type ReviewWorkspaceOwner = Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>

export function reviewRepositoryMatchesWorkspace(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  workspace: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): boolean {
  const owner = workspace.runtimeOwnerEnvironmentId?.trim()
  const host = normalizeExecutionHostId(workspace.hostId)
  if (owner && getRepoExecutionHostId(repo) !== toRuntimeExecutionHostId(owner)) {
    return false
  }
  if (!host || host === getRepoExecutionHostId(repo)) {
    return true
  }
  const connectionId = getRepoSshConnectionId(repo)
  return (
    parseExecutionHostId(host)?.kind === 'ssh' &&
    Boolean(connectionId && toSshExecutionHostId(connectionId) === host)
  )
}

/** Explicit repository context is authoritative when consistent; direct SSH wins implicit recovery. */
export function resolveReviewRepository(
  repos: readonly Repo[],
  workspace: ReviewWorkspaceOwner,
  selectedRepo?: Repo
): Repo | null {
  if (selectedRepo) {
    return selectedRepo.id === workspace.repoId &&
      hasIndexedRepository(repos, selectedRepo) &&
      reviewRepositoryMatchesWorkspace(selectedRepo, workspace)
      ? selectedRepo
      : null
  }
  const owner = workspace.runtimeOwnerEnvironmentId?.trim()
  const host = normalizeExecutionHostId(workspace.hostId)
  const repo =
    findIndexedReviewRepository(
      repos,
      workspace.repoId,
      owner ? toRuntimeExecutionHostId(owner) : (host ?? undefined),
      owner && parseExecutionHostId(host)?.kind === 'ssh' ? (host ?? undefined) : undefined
    ) ??
    (!owner && !host
      ? findIndexedReviewRepository(repos, workspace.repoId, LOCAL_EXECUTION_HOST_ID)
      : null)
  return repo && reviewRepositoryMatchesWorkspace(repo, workspace) ? repo : null
}
