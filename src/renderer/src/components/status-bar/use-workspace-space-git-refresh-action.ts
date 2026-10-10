import { useCallback } from 'react'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import { useAppStore } from '../../store'
import { findRepoForHost } from '../../store/slices/repo-host-identity'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
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
      const host = parseExecutionHostId(worktree.executionHostId)
      const ownerSettings = settings
        ? {
            ...settings,
            activeRuntimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
          }
        : { activeRuntimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null }

      return (
        owner
          ? getRuntimeGitStatus({
              settings: ownerSettings,
              worktreeId: worktree.worktreeId,
              worktreePath: worktree.path,
              connectionId: owner.connectionId ?? undefined
            })
          : Promise.reject(new Error('Workspace owner is no longer available'))
      )
        .then((status) => {
          if (gitStatusScanGenerationRef.current !== scanGeneration) {
            return
          }
          const nextStatus = new Map(gitStatusByWorktreeIdentityRef.current)
          nextStatus.set(identity, (status as GitStatusResult).entries)
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
