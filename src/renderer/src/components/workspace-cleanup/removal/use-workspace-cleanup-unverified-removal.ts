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
import {
  mergeWorkspaceCleanupRowFailures,
  startWorkspaceCleanupRowAttempt,
  type WorkspaceCleanupRowAttempts
} from './workspace-cleanup-row-failures'

type UnverifiedRemovalArgs = {
  browseAttempts: { current: WorkspaceCleanupRowAttempts }
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
  browseAttempts,
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
      const browseAttempt = startWorkspaceCleanupRowAttempt(browseAttempts.current, [identity])
      const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
      setRowFailures((current) => withoutIdentity(current, identity))
      setDeletionPhaseByIdentity((current) => ({ ...current, [identity]: 'queued' }))
      markQueued([hostId ? { id: candidate.worktreeId, hostId } : candidate.worktreeId])
      // A retry joins the run that failed (or starts a one-row run when none is left).
      const runReporter = createWorkspaceCleanupRunReporter(
        useWorkspaceCleanupRunStore.getState().beginRowRetry(candidate)
      )
      const clearOwnedDeletionState = (): void => {
        if (!browseAttempt.owns(identity)) {
          return
        }
        clearQueuedDeleteState(candidate.worktreeId, hostId ?? undefined)
        if (mountedRef.current) {
          setDeletionPhaseByIdentity((current) => withoutIdentity(current, identity))
        }
      }
      const reportBrowseResult = (result: WorkspaceCleanupRemoveResult): void => {
        clearOwnedDeletionState()
        const settlement = browseAttempt.settle(result)
        if (mountedRef.current) {
          setRowFailures((current) => mergeWorkspaceCleanupRowFailures(current, settlement))
          onDeselect(settlement.removedIdentities)
        }
      }
      startWorkspaceCleanupBackgroundRemoval({
        candidates: [candidate],
        removeCandidates,
        canReportFailure: browseAttempt.canReportFailure,
        snapshotPruneBatch: createWorkspaceCleanupSnapshotPruneBatch(),
        getRemoveOptions: () => ({
          unverifiedRemovalConsent: { identity, attemptId }
        }),
        onRowStarted: runReporter.onRowStarted,
        onRowRemoved: runReporter.onRowRemoved,
        onProgress: () => {
          if (mountedRef.current && browseAttempt.owns(identity)) {
            setDeletionPhaseByIdentity((current) => ({ ...current, [identity]: 'deleting' }))
          }
        },
        onRowFailed: (failure) => {
          runReporter.onRowFailed(failure)
          clearOwnedDeletionState()
        },
        onResult: (result) => {
          runReporter.onResult(result)
          reportBrowseResult(result)
        },
        onLateResult: (result) => {
          runReporter.onLateResult(result)
          reportBrowseResult(result)
        },
        onError: (error) => {
          runReporter.onError(error)
          clearOwnedDeletionState()
        }
      })
    },
    [
      beginConsent,
      browseAttempts,
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

function withoutIdentity<T>(current: Record<string, T>, identity: string): Record<string, T> {
  const next = { ...current }
  delete next[identity]
  return next
}
