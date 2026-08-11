import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import {
  startWorkspaceCleanupBackgroundRemoval,
  type WorkspaceCleanupRemovalProgress
} from './workspace-cleanup-background-removal'
import { filterWorkspaceCleanupRemovalCandidates } from './workspace-cleanup-removal-candidates'

type WorkspaceCleanupSelectedIdsSetter = Dispatch<SetStateAction<Set<string>>>

export type WorkspaceCleanupRemovalSession = {
  confirming: boolean
  confirmCandidates: WorkspaceCleanupCandidate[]
  removalProgress: WorkspaceCleanupRemovalProgress | null
  removalInFlight: boolean
  rowFailures: Record<string, string>
  removalInFlightRef: RefObject<boolean>
  clearRowFailures: () => void
  resetForOpen: () => void
  applyScanDefaults: (
    candidates: readonly WorkspaceCleanupCandidate[],
    deletingWorktreeIds: ReadonlySet<string>
  ) => void
  openConfirmRemove: (candidates: readonly WorkspaceCleanupCandidate[]) => void
  cancelConfirmRemove: () => void
  backToWorkspaceCleanupList: () => void
  confirmRemove: () => void
}

export function useWorkspaceCleanupRemovalSession({
  mountedRef,
  setSelectedIds,
  closeModal,
  removeCandidates,
  markWorktreesQueuedForDeletion,
  clearWorktreeDeleteState
}: {
  mountedRef: RefObject<boolean>
  setSelectedIds: WorkspaceCleanupSelectedIdsSetter
  closeModal: AppState['closeModal']
  removeCandidates: AppState['removeWorkspaceCleanupCandidates']
  markWorktreesQueuedForDeletion: AppState['markWorktreesQueuedForDeletion']
  clearWorktreeDeleteState: AppState['clearWorktreeDeleteState']
}): WorkspaceCleanupRemovalSession {
  const [confirming, setConfirming] = useState(false)
  const [confirmCandidates, setConfirmCandidates] = useState<WorkspaceCleanupCandidate[]>([])
  const [removalProgress, setRemovalProgress] = useState<WorkspaceCleanupRemovalProgress | null>(
    null
  )
  // Why: progress arrives after the click; the ref synchronously rejects a second batch.
  const [removalInFlight, setRemovalInFlight] = useState(false)
  const [rowFailures, setRowFailures] = useState<Record<string, string>>({})
  const removalInFlightRef = useRef(false)
  // Why: an older batch's late settlement must not mutate a newer batch's UI.
  const removalBatchIdRef = useRef(0)

  const clearRowFailures = useCallback(() => setRowFailures({}), [])

  const resetForOpen = useCallback(() => {
    setConfirming(false)
    setRowFailures({})
    setSelectedIds(new Set())
  }, [setSelectedIds])

  const applyScanDefaults = useCallback(
    (
      candidates: readonly WorkspaceCleanupCandidate[],
      deletingWorktreeIds: ReadonlySet<string>
    ) => {
      if (removalInFlightRef.current) {
        return
      }
      setSelectedIds(getDefaultSelectedWorkspaceCleanupIds(candidates, deletingWorktreeIds))
      setConfirming(false)
      setRowFailures({})
    },
    [setSelectedIds]
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

  // Why: Back exposes per-row progress without cancelling the batch; Close dismisses the modal.
  const backToWorkspaceCleanupList = useCallback(() => {
    setConfirming(false)
    setConfirmCandidates([])
  }, [])

  const clearQueuedDeleteState = useCallback(
    (worktreeId: string) => {
      const deleteState = useAppStore.getState().deleteStateByWorktreeId[worktreeId]
      // Why: rows that fail before removal starts must not stay queued in the sidebar.
      if (deleteState?.isDeleting && deleteState.error === null && deleteState.phase === 'queued') {
        clearWorktreeDeleteState(worktreeId)
      }
    },
    [clearWorktreeDeleteState]
  )

  const deselectRemovedIds = useCallback(
    (removedIds: readonly string[]) => {
      if (removedIds.length === 0) {
        return
      }
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const id of removedIds) {
          next.delete(id)
        }
        return next
      })
    },
    [setSelectedIds]
  )

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
    // Why: hung late settlements retain callbacks, so capture ids instead of candidate objects.
    const removableWorktreeIds = removableCandidates.map((candidate) => candidate.worktreeId)
    setRowFailures({})
    markWorktreesQueuedForDeletion(removableWorktreeIds)
    startWorkspaceCleanupBackgroundRemoval({
      candidates: removableCandidates,
      removeCandidates,
      onProgress: (progress) => {
        if (mountedRef.current) {
          setRemovalProgress(progress)
        }
      },
      onRowFailed: (failure) => {
        clearQueuedDeleteState(failure.worktreeId)
      },
      onResult: (result) => {
        const nextFailures: Record<string, string> = {}
        for (const failure of result.failures) {
          nextFailures[failure.worktreeId] = failure.message
          clearQueuedDeleteState(failure.worktreeId)
        }
        if (mountedRef.current) {
          setRowFailures(nextFailures)
          deselectRemovedIds(result.removedIds)
          setRemovalProgress(null)
          setRemovalInFlight(false)
          setConfirming(false)
          setConfirmCandidates([])
        }
        removalInFlightRef.current = false
      },
      onLateResult: (result) => {
        for (const failure of result.failures) {
          // Why: a late preflight failure can leave a row that never started stuck as queued.
          clearQueuedDeleteState(failure.worktreeId)
        }
        if (!mountedRef.current || removalBatchIdRef.current !== removalBatchId) {
          return
        }
        setRowFailures((current) => {
          const next = { ...current }
          for (const id of result.removedIds) {
            delete next[id]
          }
          for (const failure of result.failures) {
            next[failure.worktreeId] = failure.message
          }
          return next
        })
        deselectRemovedIds(result.removedIds)
      },
      onError: () => {
        // Why: the batch driver is gone, so nothing will settle these rows later; clear
        // unconditionally (not just queued ones) or a hung 'deleting' row stays stuck in
        // the sidebar and filterWorkspaceCleanupRemovalCandidates blocks every retry.
        for (const worktreeId of removableWorktreeIds) {
          clearWorktreeDeleteState(worktreeId)
        }
        if (mountedRef.current) {
          setRemovalProgress(null)
          setRemovalInFlight(false)
          setConfirming(false)
          setConfirmCandidates([])
        }
        removalInFlightRef.current = false
      }
    })
  }, [
    clearQueuedDeleteState,
    clearWorktreeDeleteState,
    confirmCandidates,
    deselectRemovedIds,
    markWorktreesQueuedForDeletion,
    mountedRef,
    removeCandidates
  ])

  return {
    confirming,
    confirmCandidates,
    removalProgress,
    removalInFlight,
    rowFailures,
    removalInFlightRef,
    clearRowFailures,
    resetForOpen,
    applyScanDefaults,
    openConfirmRemove,
    cancelConfirmRemove,
    backToWorkspaceCleanupList,
    confirmRemove
  }
}

function getDefaultSelectedWorkspaceCleanupIds(
  candidates: readonly WorkspaceCleanupCandidate[],
  deletingWorktreeIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    candidates
      .filter(
        (candidate) => candidate.selectedByDefault && !deletingWorktreeIds.has(candidate.worktreeId)
      )
      .map((candidate) => candidate.worktreeId)
  )
}
