import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { getWorktreeDeleteStateKey } from '@/store/slices/worktrees/teardown/worktree-delete-state'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import {
  startWorkspaceCleanupBackgroundRemoval,
  type WorkspaceCleanupRemovalProgress
} from './settlement/workspace-cleanup-background-removal'
import {
  filterWorkspaceCleanupRemovalCandidates,
  isWorkspaceCleanupRemovalBusy
} from './workspace-cleanup-removal-candidates'
import { createWorkspaceCleanupSnapshotPruneBatch } from './workspace-cleanup-snapshot-prune-batch'
import { updateWorkspaceCleanupDeletionPhases } from './workspace-cleanup-deletion-phases'
import { useWorkspaceCleanupUnverifiedRemoval } from './use-workspace-cleanup-unverified-removal'
import { useWorkspaceCleanupRunStore } from './run/workspace-cleanup-run-store'
import {
  mergeWorkspaceCleanupRowFailures,
  startWorkspaceCleanupRowAttempt,
  type WorkspaceCleanupRowAttempts
} from './workspace-cleanup-row-failures'
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
  confirmStopAgents: (candidates?: ConfirmationCandidates) => void
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
  // Browse keeps attempt ownership after Done dismisses the run summary.
  const browseAttempts = useRef<WorkspaceCleanupRowAttempts>(new Map())

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
    browseAttempts,
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
      if (
        isWorkspaceCleanupRemovalBusy(candidate, useAppStore.getState().deleteStateByWorktreeId)
      ) {
        clearAgentStopRequest()
        return
      }
      const [approvedCandidate] = approveAgentStops([candidate], candidate) ?? []
      if (approvedCandidate) {
        startUnverifiedRemoval(approvedCandidate)
      }
    },
    [approveAgentStops, clearAgentStopRequest, startUnverifiedRemoval]
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

  const confirmRemove = (candidates: ConfirmationCandidates = confirmCandidates): void => {
    if (removalInFlightRef.current) {
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
    // Hung settlements retain callbacks indefinitely; capture IDs rather than candidate objects.
    const removalRows = removableCandidates.map((candidate) => ({
      identity: getWorkspaceCleanupCandidateIdentity(candidate),
      id: candidate.worktreeId,
      hostId: resolveWorkspaceCleanupRemovalHostId(candidate) ?? undefined
    }))
    const removableIdentities = removalRows.map(({ identity }) => identity)
    const browseAttempt = startWorkspaceCleanupRowAttempt(
      browseAttempts.current,
      removableIdentities
    )
    setRowFailures({})
    const runReporter = createWorkspaceCleanupRunReporter(
      useWorkspaceCleanupRunStore.getState().startRun(removableCandidates)
    )
    setDeletionPhaseByIdentity((current) => ({
      ...current,
      ...Object.fromEntries(removableIdentities.map((identity) => [identity, 'queued' as const]))
    }))
    markWorktreesQueuedForDeletion(
      removalRows.map(({ id, hostId }) => (hostId ? { id, hostId } : id))
    )
    const updateOwnedDeletionPhases = (phase: 'deleting' | null): void => {
      const ownedIdentities = removableIdentities.filter(browseAttempt.owns)
      setDeletionPhaseByIdentity((current) =>
        updateWorkspaceCleanupDeletionPhases(current, ownedIdentities, phase)
      )
    }
    const settle = (): void => {
      removalInFlightRef.current = false
      if (mountedRef.current) {
        updateOwnedDeletionPhases(null)
        setRemovalProgress(null)
        setRemovalInFlight(false)
        setConfirming(false)
        setConfirmCandidates([])
      }
    }
    const reportBrowseResult = (result: WorkspaceCleanupRemoveResult): void => {
      const settlement = browseAttempt.settle(result)
      for (const failure of settlement.failures) {
        clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
      }
      if (mountedRef.current) {
        setRowFailures((current) => mergeWorkspaceCleanupRowFailures(current, settlement))
        onDeselect(settlement.removedIdentities)
      }
    }
    const handleRemovalError = (): void => {
      runReporter.onError()
      for (const { identity, id, hostId } of removalRows) {
        if (browseAttempt.owns(identity)) {
          clearWorktreeDeleteState(id, hostId)
        }
      }
      settle()
    }
    try {
      const snapshotPruneBatch = createWorkspaceCleanupSnapshotPruneBatch()
      startWorkspaceCleanupBackgroundRemoval({
        candidates: removableCandidates,
        removeCandidates,
        canReportFailure: browseAttempt.canReportFailure,
        snapshotPruneBatch,
        onProgress: (progress) => {
          if (mountedRef.current) {
            setRemovalProgress(progress)
            updateOwnedDeletionPhases('deleting')
          }
        },
        onRowStarted: runReporter.onRowStarted,
        onRowRemoved: runReporter.onRowRemoved,
        onRowFailed: (failure) => {
          runReporter.onRowFailed(failure)
          const identity = getWorkspaceCleanupFailureIdentity(failure)
          if (!browseAttempt.owns(identity)) {
            return
          }
          clearQueuedDeleteState(failure.worktreeId, failure.executionHostId)
          if (mountedRef.current) {
            setDeletionPhaseByIdentity((current) =>
              updateWorkspaceCleanupDeletionPhases(current, [identity], null)
            )
          }
        },
        onResult: (result) => {
          runReporter.onResult(result)
          settle()
          reportBrowseResult(result)
        },
        onLateResult: (result) => {
          runReporter.onLateResult(result)
          reportBrowseResult(result)
        },
        onError: handleRemovalError
      })
    } catch {
      handleRemovalError()
    }
  }

  const agentStopRequest = agentStopGate.request
  const confirmStopAgents = (candidates?: ConfirmationCandidates): void => {
    if (agentStopRequest?.unverifiedCandidate) {
      confirmUnverifiedRemoval(agentStopRequest.unverifiedCandidate)
    } else {
      confirmRemove(candidates)
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
