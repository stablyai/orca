import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import type { WorkspaceCleanupDeletionPhase } from './workspace-cleanup-candidate-row'
import { createWorkspaceCleanupSnapshotPruneBatch } from './workspace-cleanup-snapshot-prune-batch'

type UnverifiedRemovalArgs = {
  setRowFailures: Dispatch<SetStateAction<Record<string, WorkspaceCleanupFailure>>>
  setDeletionPhaseByIdentity: Dispatch<
    SetStateAction<Record<string, WorkspaceCleanupDeletionPhase>>
  >
  clearQueuedDeleteState: (
    worktreeId: string,
    executionHostId?: WorkspaceCleanupFailure['executionHostId']
  ) => void
  onDeselect: (removedIdentities: readonly string[]) => void
}

export function useWorkspaceCleanupUnverifiedRemoval({
  setRowFailures,
  setDeletionPhaseByIdentity,
  clearQueuedDeleteState,
  onDeselect
}: UnverifiedRemovalArgs): (candidate: WorkspaceCleanupCandidate) => void {
  const beginConsent = useAppStore((state) => state.beginUnverifiedRemovalConsent)
  const removeCandidates = useAppStore((state) => state.removeWorkspaceCleanupCandidates)
  const markQueued = useAppStore((state) => state.markWorktreesQueuedForDeletion)
  const mountedRef = useMountedRef()

  return useCallback(
    (candidate) => {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      const attemptId = beginConsent(identity)
      if (!attemptId) {
        return
      }
      const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
      setRowFailures((current) => withoutIdentity(current, identity))
      setDeletionPhaseByIdentity((current) => ({ ...current, [identity]: 'queued' }))
      markQueued([hostId ? { id: candidate.worktreeId, hostId } : candidate.worktreeId])
      startWorkspaceCleanupBackgroundRemoval({
        candidates: [candidate],
        removeCandidates,
        snapshotPruneBatch: createWorkspaceCleanupSnapshotPruneBatch(),
        getRemoveOptions: () => ({
          unverifiedRemovalConsent: { identity, attemptId }
        }),
        onProgress: () => {
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => ({ ...current, [identity]: 'deleting' }))
          }
        },
        onRowFailed: (failure) => {
          clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          // A preflight/timeout failure can arrive before the background
          // batch settles; drop the optimistic deleting overlay immediately.
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => withoutIdentity(current, identity))
          }
        },
        onResult: (result) => {
          clearQueuedDeleteState(candidate.worktreeId, hostId ?? undefined)
          if (mountedRef.current) {
            applyResult(result, identity, setRowFailures, setDeletionPhaseByIdentity, onDeselect)
          }
        },
        onLateResult: (result) => {
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => withoutIdentity(current, identity))
            applyLateResult(result, setRowFailures, onDeselect)
          }
        },
        onError: () => {
          clearQueuedDeleteState(candidate.worktreeId, hostId ?? undefined)
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => withoutIdentity(current, identity))
          }
        }
      })
    },
    [
      beginConsent,
      clearQueuedDeleteState,
      markQueued,
      mountedRef,
      onDeselect,
      removeCandidates,
      setDeletionPhaseByIdentity,
      setRowFailures
    ]
  )
}

function applyResult(
  result: WorkspaceCleanupRemoveResult,
  identity: string,
  setFailures: UnverifiedRemovalArgs['setRowFailures'],
  setPhases: UnverifiedRemovalArgs['setDeletionPhaseByIdentity'],
  onDeselect: UnverifiedRemovalArgs['onDeselect']
): void {
  setPhases((current) => withoutIdentity(current, identity))
  setFailures((current) => addFailures(withoutIdentity(current, identity), result.failures))
  onDeselect(result.removedIdentities)
}

function applyLateResult(
  result: WorkspaceCleanupRemoveResult,
  setFailures: UnverifiedRemovalArgs['setRowFailures'],
  onDeselect: UnverifiedRemovalArgs['onDeselect']
): void {
  setFailures((current) => {
    let next = current
    for (const identity of result.removedIdentities) {
      next = withoutIdentity(next, identity)
    }
    return addFailures(next, result.failures)
  })
  onDeselect(result.removedIdentities)
}

function addFailures(
  current: Record<string, WorkspaceCleanupFailure>,
  failures: readonly WorkspaceCleanupFailure[]
): Record<string, WorkspaceCleanupFailure> {
  const next = { ...current }
  for (const failure of failures) {
    next[getWorkspaceCleanupFailureIdentity(failure)] = failure
  }
  return next
}

function withoutIdentity<T>(current: Record<string, T>, identity: string): Record<string, T> {
  const next = { ...current }
  delete next[identity]
  return next
}

function getWorkspaceCleanupFailureIdentity(failure: WorkspaceCleanupFailure): string {
  return failure.executionHostId
    ? getWorkspaceCleanupHostIdentity(failure.executionHostId, failure.worktreeId)
    : getWorkspaceCleanupCandidateIdentity({ worktreeId: failure.worktreeId })
}
