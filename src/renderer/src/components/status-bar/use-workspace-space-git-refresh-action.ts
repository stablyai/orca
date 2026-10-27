import { useCallback } from 'react'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import { useAppStore } from '../../store'
import { findRepoForHost } from '../../store/slices/repo-host-identity'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import type { useWorkspaceSpaceManagerBindings } from './use-workspace-space-manager-bindings'

type WorkspaceSpaceManagerBindings = ReturnType<typeof useWorkspaceSpaceManagerBindings>

export function useWorkspaceSpaceGitRefreshAction(bindings: WorkspaceSpaceManagerBindings) {
  const {
    analysis,
    gitStatusByWorktreeIdentityRef,
    gitStatusScanGenerationRef,
    inFlightGitStatusRefreshes,
    setGitStatusByWorktreeIdentity,
    setGitRefreshStateByWorktreeId,
    settings
  } = bindings

  const refreshWorkspaceGitStatus = useCallback(
    (worktree: WorkspaceSpaceWorktree): Promise<void> => {
      const identity = getWorkspaceSpaceWorktreeIdentity(worktree)
      const scanGeneration = analysis?.scannedAt ?? null
      const requestKey = `${String(scanGeneration)}:${identity}`
      const currentState = useAppStore.getState()
      if (
        gitStatusScanGenerationRef.current === scanGeneration &&
        gitStatusByWorktreeIdentityRef.current.has(identity)
      ) {
        return Promise.resolve()
      }
      if (inFlightGitStatusRefreshes.current.has(requestKey)) {
        return Promise.resolve()
      }
      inFlightGitStatusRefreshes.current.add(requestKey)

      setGitRefreshStateByWorktreeId((current) => ({
        ...current,
        [identity]: { isRefreshing: true, error: null }
      }))

      const owner = findRepoForHost(currentState.repos, worktree.repoId, {
        hostId: worktree.executionHostId,
        settings
      })
      // Why: a scan row without a host id came from this app's own scan.
      const ownerTarget = worktree.executionHostId
        ? ipcOrRuntimeTargetForHostId(worktree.executionHostId)
        : ({ kind: 'local' } as const)

      return (
        owner && ownerTarget
          ? getRuntimeGitStatus(
              {
                target: ownerTarget,
                worktreeId: worktree.worktreeId,
                worktreePath: worktree.path,
                connectionId: owner.connectionId ?? undefined
              },
              { includeLineStats: false, admissionTier: 'background' }
            )
          : Promise.reject(new Error('Workspace owner is no longer available'))
      )
        .then((status) => {
          if (gitStatusScanGenerationRef.current !== scanGeneration) {
            return
          }
          const nextStatus = new Map(gitStatusByWorktreeIdentityRef.current)
          nextStatus.set(identity, status.entries)
          gitStatusByWorktreeIdentityRef.current = nextStatus
          setGitStatusByWorktreeIdentity(nextStatus)
          setGitRefreshStateByWorktreeId((current) => ({
            ...current,
            [identity]: { isRefreshing: false, error: null }
          }))
        })
        .catch((error: unknown) => {
          if (gitStatusScanGenerationRef.current !== scanGeneration) {
            return
          }
          setGitRefreshStateByWorktreeId((current) => ({
            ...current,
            [identity]: {
              isRefreshing: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }))
        })
        .finally(() => {
          inFlightGitStatusRefreshes.current.delete(requestKey)
        })
    },
    [
      analysis?.scannedAt,
      gitStatusByWorktreeIdentityRef,
      gitStatusScanGenerationRef,
      inFlightGitStatusRefreshes,
      setGitRefreshStateByWorktreeId,
      setGitStatusByWorktreeIdentity,
      settings
    ]
  )

  return refreshWorkspaceGitStatus
}
