import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { startWorkspaceCleanupBackgroundRemoval } from './settlement/workspace-cleanup-background-removal'
import type { WorkspaceCleanupDeletionPhase } from '../candidate-list/workspace-cleanup-candidate-row'
import { useWorkspaceCleanupRunStore } from './run/workspace-cleanup-run-store'
import { createWorkspaceCleanupRunReporter } from './run/workspace-cleanup-run-reporter'
import { createWorkspaceCleanupSnapshotPruneBatch } from './workspace-cleanup-snapshot-prune-batch'
import { mergeWorkspaceCleanupRowFailures } from './workspace-cleanup-row-failures'

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
      // A retry joins the run that failed (or starts a one-row run when none is left).
      const runReporter = createWorkspaceCleanupRunReporter(
        useWorkspaceCleanupRunStore.getState().beginRowRetry(candidate)
      )
      startWorkspaceCleanupBackgroundRemoval({
        candidates: [candidate],
        removeCandidates,
        snapshotPruneBatch: createWorkspaceCleanupSnapshotPruneBatch(),
        getRemoveOptions: () => ({
          unverifiedRemovalConsent: { identity, attemptId }
        }),
        onRowStarted: runReporter.onRowStarted,
        onRowRemoved: runReporter.onRowRemoved,
        onProgress: () => {
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => ({ ...current, [identity]: 'deleting' }))
          }
        },
        onRowFailed: (failure) => {
          runReporter.onRowFailed(failure)
          clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          // Clear optimistic deleting immediately on preflight/timeout failure, before batch settlement.
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => withoutIdentity(current, identity))
          }
        },
        onResult: (result) => {
          runReporter.onResult(result)
          clearQueuedDeleteState(candidate.worktreeId, hostId ?? undefined)
          if (mountedRef.current) {
            applyResult(result, identity, setRowFailures, setDeletionPhaseByIdentity, onDeselect)
          }
        },
        onLateResult: (result) => {
          runReporter.onLateResult(result)
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) => withoutIdentity(current, identity))
            applyLateResult(result, setRowFailures, onDeselect)
          }
        },
        onError: (error) => {
          runReporter.onError(error)
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
  // This attempt's own result replaces the row's earlier failure.
  setFailures((current) =>
    mergeWorkspaceCleanupRowFailures(withoutIdentity(current, identity), result)
  )
  onDeselect(result.removedIdentities)
}

function applyLateResult(
  result: WorkspaceCleanupRemoveResult,
  setFailures: UnverifiedRemovalArgs['setRowFailures'],
  onDeselect: UnverifiedRemovalArgs['onDeselect']
): void {
  setFailures((current) => mergeWorkspaceCleanupRowFailures(current, result))
  onDeselect(result.removedIdentities)
}

function withoutIdentity<T>(current: Record<string, T>, identity: string): Record<string, T> {
  const next = { ...current }
  delete next[identity]
  return next
}
