import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import {
  useWorktreeGitStatusObservation,
  SLOW_GIT_POLL_BACKOFF
} from './use-worktree-git-status-observation'
import { useStaleConflictOperationPolling } from './stale-conflict-operation-poll'
export {
  useWorktreeGitStatusObservation,
  SLOW_GIT_POLL_BACKOFF,
  admissionTierForGitStatusRefreshReason
} from './use-worktree-git-status-observation'
export function useGitStatusPolling(options: { enabled?: boolean } = {}): void {
  useWorktreeGitStatusObservation(null, options)
  const enabled = options.enabled ?? true
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const conflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  const setConflictOperation = useAppStore((s) => s.setConflictOperation)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const isConnectionReady = useCallback(
    (id: string | null | undefined) => !id || sshConnectionStates.get(id)?.status === 'connected',
    [sshConnectionStates]
  )
  useStaleConflictOperationPolling({
    enabled,
    activeWorktreeId,
    allWorktrees,
    repoMap,
    conflictOperationByWorktree,
    setConflictOperation,
    isConnectionReady,
    slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
  })
}
