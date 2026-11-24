import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { getWorktreeDeleteStateKey } from '@/store/slices/worktrees/teardown/worktree-delete-state'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import {
  startWorkspaceCleanupBackgroundRemoval,
  type WorkspaceCleanupRemovalProgress
} from './settlement/workspace-cleanup-background-removal'
import { filterWorkspaceCleanupRemovalCandidates } from './workspace-cleanup-removal-candidates'
import { createWorkspaceCleanupSnapshotPruneBatch } from './workspace-cleanup-snapshot-prune-batch'
import { useWorkspaceCleanupUnverifiedRemoval } from './use-workspace-cleanup-unverified-removal'
import { useWorkspaceCleanupRunStore } from './run/workspace-cleanup-run-store'
import { mergeWorkspaceCleanupRowFailures } from './workspace-cleanup-row-failures'
import {
  createWorkspaceCleanupRunReporter,
  getWorkspaceCleanupFailureIdentity
} from './run/workspace-cleanup-run-reporter'
import {
  useWorkspaceCleanupAgentStopGate,
  type WorkspaceCleanupAgentStopRequest
} from './agent-consent/use-workspace-cleanup-agent-stop-gate'

type ConfirmationCandidates = readonly WorkspaceCleanupCandidate[]

export type WorkspaceCleanupRemovalController = {
  confirming: boolean
  confirmCandidates: WorkspaceCleanupCandidate[]
  removalProgress: WorkspaceCleanupRemovalProgress | null
  removalInFlight: boolean
  deletionPhaseByIdentity: Record<string, 'queued' | 'deleting'>
  /** Synchronous guard; state alone lags a second confirm click. */
  removalInFlightRef: { current: boolean }
  /** Keyed by host-qualified identity so a failure marks only the confirmed host's row. */
  rowFailures: Record<string, WorkspaceCleanupFailure>
  resetRowFailures: () => void
  resetForReopen: () => void
  openConfirmRemove: (candidates: readonly WorkspaceCleanupCandidate[]) => void
  confirmRemove: (candidates?: ConfirmationCandidates) => void
  confirmUnverifiedRemoval: (candidate: WorkspaceCleanupCandidate) => void
  cancelConfirmRemove: () => void
  backToList: () => void
  agentStopRequest: WorkspaceCleanupAgentStopRequest | null
  confirmStopAgents: () => void
  cancelStopAgents: () => void
}

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
  // Progress arrives after dispatch, so render an immediate in-flight flag while the ref guards repeat confirmation synchronously.
  const [removalInFlight, setRemovalInFlight] = useState(false)
  const [deletionPhaseByIdentity, setDeletionPhaseByIdentity] = useState<
    Record<string, 'queued' | 'deleting'>
  >({})
  const [rowFailures, setRowFailures] = useState<Record<string, WorkspaceCleanupFailure>>({})
  const removalInFlightRef = useRef(false)
  // Fence late settlements by batch so an earlier run cannot mutate newer row state.
  const removalBatchIdRef = useRef(0)

  const resetRowFailures = useCallback(() => setRowFailures({}), [])

  const agentStopGate = useWorkspaceCleanupAgentStopGate()
  const clearAgentStopRequest = agentStopGate.clear

  const resetForReopen = useCallback(() => {
    clearAgentStopRequest()
    if (removalInFlightRef.current) {
      return
    }
    setConfirming(false)
    setRowFailures({})
  }, [clearAgentStopRequest])

  const clearQueuedDeleteState = useCallback(
    (worktreeId: string, executionHostId?: WorkspaceCleanupFailure['executionHostId']) => {
      const state = useAppStore.getState()
      const deleteState =
        state.deleteStateByWorktreeId[getWorktreeDeleteStateKey(state, worktreeId, executionHostId)]
      // Clear queued overlays for pre-dispatch failures; deleting/error rows keep their own state.
      if (deleteState?.isDeleting && deleteState.error === null && deleteState.phase === 'queued') {
        clearWorktreeDeleteState(worktreeId, executionHostId)
      }
    },
    [clearWorktreeDeleteState]
  )

  const startUnverifiedRemoval = useWorkspaceCleanupUnverifiedRemoval({
    setRowFailures,
    setDeletionPhaseByIdentity,
    clearQueuedDeleteState,
    onDeselect
  })

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

  const approveAgentStops = agentStopGate.approve
  const confirmUnverifiedRemoval = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      const [approvedCandidate] = approveAgentStops([candidate], candidate) ?? []
      if (approvedCandidate) {
        startUnverifiedRemoval(approvedCandidate)
      }
    },
    [approveAgentStops, startUnverifiedRemoval]
  )

  const cancelConfirmRemove = useCallback(() => {
    clearAgentStopRequest()
    if (removalProgress) {
      closeModal()
      return
    }
    setConfirming(false)
    setConfirmCandidates([])
  }, [clearAgentStopRequest, closeModal, removalProgress])

  // Header X leaves progress running in the list while blocking re-entry; cancelConfirmRemove closes the dialog mid-batch instead.
  const backToList = useCallback(() => {
    clearAgentStopRequest()
    setConfirming(false)
    setConfirmCandidates([])
  }, [clearAgentStopRequest])

  const settle = useCallback(() => {
    setRemovalProgress(null)
    setRemovalInFlight(false)
    setConfirming(false)
    setConfirmCandidates([])
    setDeletionPhaseByIdentity({})
  }, [])

  const confirmRemove = (candidates: ConfirmationCandidates = confirmCandidates): void => {
    if (candidates.length === 0 || removalInFlightRef.current) {
      return
    }
    const filteredCandidates = filterWorkspaceCleanupRemovalCandidates(
      candidates,
      useAppStore.getState().deleteStateByWorktreeId
    )
    if (filteredCandidates.length === 0) {
      clearAgentStopRequest()
      setConfirming(false)
      setConfirmCandidates([])
      return
    }
    const removableCandidates = approveAgentStops(filteredCandidates, null)
    if (!removableCandidates) {
      setConfirmCandidates(filteredCandidates)
      return
    }
    removalInFlightRef.current = true
    setRemovalInFlight(true)
    removalBatchIdRef.current += 1
    const removalBatchId = removalBatchIdRef.current
    // Hung settlements retain callbacks indefinitely; capture IDs rather than candidate objects.
    const removableDeleteStateTargets = removableCandidates.map((candidate) => {
      const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
      return hostId ? { id: candidate.worktreeId, hostId } : candidate.worktreeId
    })
    const removableIdentities = removableCandidates.map(getWorkspaceCleanupCandidateIdentity)
    setRowFailures({})
    const runReporter = createWorkspaceCleanupRunReporter(
      useWorkspaceCleanupRunStore.getState().startRun(removableCandidates)
    )
    setDeletionPhaseByIdentity(
      Object.fromEntries(removableIdentities.map((identity) => [identity, 'queued' as const]))
    )
    markWorktreesQueuedForDeletion(removableDeleteStateTargets)
    const handleRemovalError = (): void => {
      runReporter.onError()
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
      const snapshotPruneBatch = createWorkspaceCleanupSnapshotPruneBatch()
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
        onRowStarted: runReporter.onRowStarted,
        onRowRemoved: runReporter.onRowRemoved,
        onRowFailed: (failure) => {
          clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          runReporter.onRowFailed(failure)
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
          runReporter.onResult(result)
          for (const failure of result.failures) {
            // Why: defensively covers failures that never reached onRowFailed.
            clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          }
          if (mountedRef.current) {
            setRowFailures((current) => mergeWorkspaceCleanupRowFailures(current, result))
            onDeselect(result.removedIdentities)
            settle()
          }
          removalInFlightRef.current = false
        },
        onLateResult: (result) => {
          runReporter.onLateResult(result)
          for (const failure of result.failures) {
            // Late preflight failures may never reach deleting; clear their queued overlay too.
            clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          }
          if (!mountedRef.current || removalBatchIdRef.current !== removalBatchId) {
            return
          }
          setRowFailures((current) => mergeWorkspaceCleanupRowFailures(current, result))
          onDeselect(result.removedIdentities)
        },
        onError: handleRemovalError
      })
    } catch {
      handleRemovalError()
    }
  }

  const agentStopRequest = agentStopGate.request
  const confirmStopAgents = (): void => {
    if (agentStopRequest?.unverifiedCandidate) {
      confirmUnverifiedRemoval(agentStopRequest.unverifiedCandidate)
    } else {
      confirmRemove()
    }
  }

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
    confirmUnverifiedRemoval,
    cancelConfirmRemove,
    backToList,
    agentStopRequest,
    confirmStopAgents,
    cancelStopAgents: clearAgentStopRequest
  }
}
