import { useCallback } from 'react'
import type { AppState } from '@/store/types'
import { findRepoForHost, getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export function resolveWorktreeVisibilityHostTarget(
  state: Pick<AppState, 'repos' | 'settings' | 'detectedWorktreesByRepo'>,
  repoId: string,
  modalHostId: unknown
) {
  const requestedHostId =
    typeof modalHostId === 'string' ? parseExecutionHostId(modalHostId)?.id : undefined
  const repo = findRepoForHost(state.repos, repoId, {
    hostId: requestedHostId,
    settings: state.settings
  })
  const detectedForRepo = repoId ? state.detectedWorktreesByRepo[repoId] : undefined
  const detected =
    detectedForRepo && repo && requestedHostId
      ? {
          ...detectedForRepo,
          worktrees: detectedForRepo.worktrees.filter(
            (worktree) => getWorktreeExecutionHostId(worktree, repo) === requestedHostId
          )
        }
      : detectedForRepo
  const scope = repo ? getRepoHostIdentity(repo) : `${requestedHostId ?? ''}\0${repoId}`
  return { detected, repo, requestedHostId, scope }
}

export function useWorktreeVisibilityHostActions(
  fetchWorktrees: AppState['fetchWorktrees'],
  updateRepo: AppState['updateRepo'],
  requestedHostId: ExecutionHostId | undefined
) {
  const refreshTargetRepo = useCallback(
    (repoId: string, options?: { requireAuthoritative?: boolean }) =>
      fetchWorktrees(repoId, {
        ...options,
        ...(requestedHostId ? { executionHostId: requestedHostId } : {})
      }),
    [fetchWorktrees, requestedHostId]
  )
  const updateTargetRepo = useCallback(
    (repoId: string, updates: Parameters<AppState['updateRepo']>[1]) =>
      requestedHostId
        ? updateRepo(repoId, updates, { hostId: requestedHostId })
        : updateRepo(repoId, updates),
    [requestedHostId, updateRepo]
  )
  return { refreshTargetRepo, updateTargetRepo }
}
