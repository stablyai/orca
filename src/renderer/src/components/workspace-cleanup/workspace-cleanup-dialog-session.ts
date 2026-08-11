import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  useWorkspaceCleanupRemovalSession,
  type WorkspaceCleanupRemovalSession
} from './workspace-cleanup-removal-session'
import { useWorkspaceCleanupScanSession } from './workspace-cleanup-scan-session'
import type {
  WorkspaceCleanupFilters,
  WorkspaceCleanupSortDirection,
  WorkspaceCleanupSortKey
} from './workspace-cleanup-presentation'
import type { WorkspaceCleanupView } from './workspace-cleanup-view-selection'

export const DEFAULT_WORKSPACE_CLEANUP_FILTERS: WorkspaceCleanupFilters = {
  query: '',
  time: 'all',
  review: 'all',
  git: 'all',
  context: 'all'
}

type WorkspaceCleanupStateSetter<T> = Dispatch<SetStateAction<T>>
type PublicRemovalSession = Omit<
  WorkspaceCleanupRemovalSession,
  'clearRowFailures' | 'resetForOpen'
>

export type WorkspaceCleanupDialogSession = PublicRemovalSession & {
  open: boolean
  loading: boolean
  selectedIds: Set<string>
  setSelectedIds: WorkspaceCleanupStateSetter<Set<string>>
  expandedRowIds: Set<string>
  setExpandedRowIds: WorkspaceCleanupStateSetter<Set<string>>
  activeView: WorkspaceCleanupView
  setActiveView: WorkspaceCleanupStateSetter<WorkspaceCleanupView>
  repoSelection: ReadonlySet<string>
  setRepoSelection: WorkspaceCleanupStateSetter<ReadonlySet<string>>
  filters: WorkspaceCleanupFilters
  setFilters: WorkspaceCleanupStateSetter<WorkspaceCleanupFilters>
  sortKey: WorkspaceCleanupSortKey
  setSortKey: WorkspaceCleanupStateSetter<WorkspaceCleanupSortKey>
  sortDirection: WorkspaceCleanupSortDirection
  setSortDirection: WorkspaceCleanupStateSetter<WorkspaceCleanupSortDirection>
  selectedDefaultsScanAtRef: RefObject<number | null>
  close: () => void
  markCandidateViewed: (candidate: WorkspaceCleanupCandidate) => void
  restoreDismissals: () => void
  startScan: (options?: { notifyWhenReady?: boolean }) => void
  ignoreCandidate: (candidate: WorkspaceCleanupCandidate) => void
}

export function useWorkspaceCleanupDialogSession(): WorkspaceCleanupDialogSession {
  const {
    open,
    loading,
    openModal,
    closeModal,
    scanWorkspaceCleanup,
    markCandidateViewed,
    dismissCandidates,
    resetDismissals,
    removeCandidates,
    markWorktreesQueuedForDeletion,
    clearWorktreeDeleteState
  } = useAppStore(
    useShallow((state) => ({
      open: state.activeModal === 'workspace-cleanup',
      loading: state.workspaceCleanupLoading,
      openModal: state.openModal,
      closeModal: state.closeModal,
      scanWorkspaceCleanup: state.scanWorkspaceCleanup,
      markCandidateViewed: state.markWorkspaceCleanupCandidateViewed,
      dismissCandidates: state.dismissWorkspaceCleanupCandidates,
      resetDismissals: state.resetWorkspaceCleanupDismissals,
      removeCandidates: state.removeWorkspaceCleanupCandidates,
      markWorktreesQueuedForDeletion: state.markWorktreesQueuedForDeletion,
      clearWorktreeDeleteState: state.clearWorktreeDeleteState
    }))
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(() => new Set())
  const [activeView, setActiveView] = useState<WorkspaceCleanupView>('ready')
  const [repoSelection, setRepoSelection] = useState<ReadonlySet<string>>(() => new Set())
  const [filters, setFilters] = useState<WorkspaceCleanupFilters>(DEFAULT_WORKSPACE_CLEANUP_FILTERS)
  const [sortKey, setSortKey] = useState<WorkspaceCleanupSortKey>('activity')
  const [sortDirection, setSortDirection] = useState<WorkspaceCleanupSortDirection>('asc')
  const selectedDefaultsScanAtRef = useRef<number | null>(null)
  const autoScanAttemptedForOpenRef = useRef(false)
  const wasOpenRef = useRef(false)
  const mountedRef = useMountedRef()
  const removal = useWorkspaceCleanupRemovalSession({
    mountedRef,
    setSelectedIds,
    closeModal,
    removeCandidates,
    markWorktreesQueuedForDeletion,
    clearWorktreeDeleteState
  })
  const { clearRowFailures, resetForOpen, ...publicRemoval } = removal
  const startScan = useWorkspaceCleanupScanSession({
    open,
    mountedRef,
    openModal,
    scanWorkspaceCleanup,
    clearRowFailures
  })

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      autoScanAttemptedForOpenRef.current = false
      return
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true
      autoScanAttemptedForOpenRef.current = false
      if (!removal.removalInFlightRef.current) {
        setActiveView('ready')
        setFilters(DEFAULT_WORKSPACE_CLEANUP_FILTERS)
        setSortKey('activity')
        setSortDirection('asc')
        resetForOpen()
      }
    }
    // Why: reopening mid-batch must preserve progress and avoid a scan the removal would invalidate.
    if (!loading && !autoScanAttemptedForOpenRef.current && !removal.removalInFlightRef.current) {
      autoScanAttemptedForOpenRef.current = true
      startScan({ notifyWhenReady: true })
    }
  }, [loading, open, removal.removalInFlightRef, resetForOpen, startScan])

  const ignoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      void dismissCandidates([candidate])
        .then(() => {
          if (!mountedRef.current) {
            return
          }
          setSelectedIds((current) => {
            const next = new Set(current)
            next.delete(candidate.worktreeId)
            return next
          })
        })
        .catch((error: unknown) => {
          if (!mountedRef.current) {
            return
          }
          toast.error(
            translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7f451a3e2c',
              'Could not ignore cleanup suggestion'
            ),
            { description: error instanceof Error ? error.message : String(error) }
          )
        })
    },
    [dismissCandidates, mountedRef]
  )

  const restoreDismissals = useCallback(() => {
    void resetDismissals()
  }, [resetDismissals])

  return {
    open,
    loading,
    selectedIds,
    setSelectedIds,
    expandedRowIds,
    setExpandedRowIds,
    activeView,
    setActiveView,
    repoSelection,
    setRepoSelection,
    filters,
    setFilters,
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,
    selectedDefaultsScanAtRef,
    close: closeModal,
    markCandidateViewed,
    restoreDismissals,
    startScan,
    ignoreCandidate,
    ...publicRemoval
  }
}
