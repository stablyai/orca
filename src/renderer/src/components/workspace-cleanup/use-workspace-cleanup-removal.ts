import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'
import {
  startWorkspaceCleanupBackgroundRemoval,
  type WorkspaceCleanupRemovalProgress
} from './workspace-cleanup-background-removal'
import { filterWorkspaceCleanupRemovalCandidates } from './workspace-cleanup-removal-candidates'

export type WorkspaceCleanupRemovalController = {
  confirming: boolean
  confirmCandidates: WorkspaceCleanupCandidate[]
  removalProgress: WorkspaceCleanupRemovalProgress | null
  removalInFlight: boolean
  deletionPhaseByIdentity: Record<string, 'queued' | 'deleting'>
  /** Synchronous guard; state alone lags a second confirm click. */
  removalInFlightRef: { current: boolean }
  /** Keyed by host-qualified identity so a failure marks only the confirmed host's row. */
  rowFailures: Record<string, string>
  resetRowFailures: () => void
  resetForReopen: () => void
  openConfirmRemove: (candidates: readonly WorkspaceCleanupCandidate[]) => void
  confirmRemove: () => void
  cancelConfirmRemove: () => void
  backToList: () => void
}

/**
 * Owns the destructive path: confirm gate, background batch, late settlement,
 * and the queued-delete overlay each row shows in the sidebar.
 */
export function useWorkspaceCleanupRemoval({
  onDeselect,
  closeModal
}: {
  onDeselect: (removedIdentities: readonly string[]) => void
  closeModal: () => void
}): WorkspaceCleanupRemovalController {
  const removeCandidates = useAppStore((s) => s.removeWorkspaceCleanupCandidates)
  const markWorktreesQueuedForDeletion = useAppStore((s) => s.markWorktreesQueuedForDeletion)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const mountedRef = useMountedRef()

  const [confirming, setConfirming] = useState(false)
  const [confirmCandidates, setConfirmCandidates] = useState<WorkspaceCleanupCandidate[]>([])
  const [removalProgress, setRemovalProgress] = useState<WorkspaceCleanupRemovalProgress | null>(
    null
  )
  // Why: `removalProgress` only arrives once the batch reports, so rendering
  // needs its own in-flight flag; removalInFlightRef stays the synchronous guard.
  const [removalInFlight, setRemovalInFlight] = useState(false)
  const [deletionPhaseByIdentity, setDeletionPhaseByIdentity] = useState<
    Record<string, 'queued' | 'deleting'>
  >({})
  const [rowFailures, setRowFailures] = useState<Record<string, string>>({})
  const removalInFlightRef = useRef(false)
  // Why: the dialog stays mounted across cleanup runs, so late settlements from
  // an earlier batch must not mutate a newer batch's row state.
  const removalBatchIdRef = useRef(0)

  const resetRowFailures = useCallback(() => setRowFailures({}), [])

  const resetForReopen = useCallback(() => {
    if (removalInFlightRef.current) {
      return
    }
    setConfirming(false)
    setRowFailures({})
  }, [])

  const clearQueuedDeleteState = useCallback(
    (worktreeId: string, executionHostId?: WorkspaceCleanupFailure['executionHostId']) => {
      const deleteStateByWorktreeId = useAppStore.getState().deleteStateByWorktreeId
      const key = executionHostId
        ? composeWorktreeHostIdentity(executionHostId, worktreeId)
        : worktreeId
      const deleteState = deleteStateByWorktreeId[key]
      // Why: candidates that fail before removal starts would otherwise stay
      // marked "Queued for deletion" in the sidebar; rows already in the
      // 'deleting' phase or failed with an error keep their own state.
      if (deleteState?.isDeleting && deleteState.error === null && deleteState.phase === 'queued') {
        clearWorktreeDeleteState(worktreeId, executionHostId)
      }
    },
    [clearWorktreeDeleteState]
  )

  const openConfirmRemove = useCallback((candidates: readonly WorkspaceCleanupCandidate[]) => {
    const nextCandidates = filterWorkspaceCleanupRemovalCandidates(
      candidates,
      useAppStore.getState().deleteStateByWorktreeId
    )
    if (nextCandidates.length === 0) {
      return
    }
    setConfirmCandidates(nextCandidates)
    setConfirming(true)
  }, [])

  const cancelConfirmRemove = useCallback(() => {
    if (removalProgress) {
      closeModal()
      return
    }
    setConfirming(false)
    setConfirmCandidates([])
  }, [closeModal, removalProgress])

  // Why: the header X reads as "leave this screen", not "abandon the dialog". The
  // batch keeps running either way and the list shows each row's progress.
  // Diverges from cancelConfirmRemove, which closes the dialog mid-batch: here
  // removalProgress stays set until the batch settles, so re-entry stays blocked.
  const backToList = useCallback(() => {
    setConfirming(false)
    setConfirmCandidates([])
  }, [])

  const settle = useCallback(() => {
    setRemovalProgress(null)
    setRemovalInFlight(false)
    setConfirming(false)
    setConfirmCandidates([])
    setDeletionPhaseByIdentity({})
  }, [])

  const confirmRemove = useCallback(() => {
    if (confirmCandidates.length === 0 || removalInFlightRef.current) {
      return
    }
    const removableCandidates = filterWorkspaceCleanupRemovalCandidates(
      confirmCandidates,
      useAppStore.getState().deleteStateByWorktreeId
    )
    if (removableCandidates.length === 0) {
      setConfirming(false)
      setConfirmCandidates([])
      return
    }
    removalInFlightRef.current = true
    setRemovalInFlight(true)
    removalBatchIdRef.current += 1
    const removalBatchId = removalBatchIdRef.current
    // Why: a hung late settlement retains these callbacks for the renderer's
    // lifetime; capture only ids so it cannot pin the candidate objects.
    const removableDeleteStateTargets = removableCandidates.map((candidate) => {
      const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
      return hostId ? { id: candidate.worktreeId, hostId } : candidate.worktreeId
    })
    const removableIdentities = removableCandidates.map(getWorkspaceCleanupCandidateIdentity)
    setRowFailures({})
    setDeletionPhaseByIdentity(
      Object.fromEntries(removableIdentities.map((identity) => [identity, 'queued' as const]))
    )
    markWorktreesQueuedForDeletion(removableDeleteStateTargets)
    const handleRemovalError = (): void => {
      for (const target of removableDeleteStateTargets) {
        if (typeof target === 'string') {
          clearWorktreeDeleteState(target)
        } else {
          clearWorktreeDeleteState(target.id, target.hostId)
        }
      }
      if (mountedRef.current) {
        settle()
      }
      removalInFlightRef.current = false
    }
    try {
      const beginSnapshotPruneBatch = window.api.workspaceCleanup.beginRemovalSnapshotPruneBatch
      const recordSnapshotPrune = window.api.workspaceCleanup.recordRemovalSnapshotPrune
      const finishSnapshotPruneBatch = window.api.workspaceCleanup.finishRemovalSnapshotPruneBatch
      const snapshotPruneBatch =
        typeof beginSnapshotPruneBatch === 'function' &&
        typeof recordSnapshotPrune === 'function' &&
        typeof finishSnapshotPruneBatch === 'function'
          ? (() => {
              const batchId = crypto.randomUUID()
              return {
                batchId,
                begin: () => beginSnapshotPruneBatch({ batchId }),
                finish: () => finishSnapshotPruneBatch({ batchId })
              }
            })()
          : undefined
      startWorkspaceCleanupBackgroundRemoval({
        candidates: removableCandidates,
        removeCandidates,
        snapshotPruneBatch,
        onProgress: (progress) => {
          if (mountedRef.current) {
            setRemovalProgress(progress)
            setDeletionPhaseByIdentity((current) =>
              Object.fromEntries(Object.keys(current).map((identity) => [identity, 'deleting']))
            )
          }
        },
        onRowFailed: (failure) => {
          clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          if (!mountedRef.current) {
            return
          }
          const identity = getWorkspaceCleanupFailureIdentity(failure)
          setDeletionPhaseByIdentity((current) => {
            const next = { ...current }
            delete next[identity]
            return next
          })
        },
        onResult: (result) => {
          const nextFailures: Record<string, string> = {}
          for (const failure of result.failures) {
            nextFailures[getWorkspaceCleanupFailureIdentity(failure)] = failure.message
            // Why: defensively covers failures that never reached onRowFailed.
            clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          }
          if (mountedRef.current) {
            setRowFailures(nextFailures)
            onDeselect(result.removedIdentities)
            settle()
          }
          removalInFlightRef.current = false
        },
        onLateResult: (result) => {
          for (const failure of result.failures) {
            // Why: a late failure can come from a hung preflight whose row never
            // reached 'deleting'; clear its queued overlay like every other path.
            clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          }
          if (!mountedRef.current || removalBatchIdRef.current !== removalBatchId) {
            return
          }
          setRowFailures((current) => {
            const next = { ...current }
            for (const identity of result.removedIdentities) {
              delete next[identity]
            }
            for (const failure of result.failures) {
              next[getWorkspaceCleanupFailureIdentity(failure)] = failure.message
            }
            return next
          })
          onDeselect(result.removedIdentities)
        },
        onError: handleRemovalError
      })
    } catch {
      handleRemovalError()
    }
  }, [
    clearQueuedDeleteState,
    clearWorktreeDeleteState,
    confirmCandidates,
    markWorktreesQueuedForDeletion,
    mountedRef,
    onDeselect,
    removeCandidates,
    settle
  ])

  return {
    confirming,
    confirmCandidates,
    removalProgress,
    removalInFlight,
    deletionPhaseByIdentity,
    removalInFlightRef,
    rowFailures,
    resetRowFailures,
    resetForReopen,
    openConfirmRemove,
    confirmRemove,
    cancelConfirmRemove,
    backToList
  }
}

/** Row key for a failure; an id-only failure lands on the local row, as before. */
function getWorkspaceCleanupFailureIdentity(failure: WorkspaceCleanupFailure): string {
  return failure.executionHostId
    ? getWorkspaceCleanupHostIdentity(failure.executionHostId, failure.worktreeId)
    : getWorkspaceCleanupCandidateIdentity({ worktreeId: failure.worktreeId })
}
