import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import {
  useWorkspaceCleanupRemoval,
  type WorkspaceCleanupRemovalController
} from './use-workspace-cleanup-removal'
import { useWorkspaceCleanupScanLifecycle } from './use-workspace-cleanup-scan-lifecycle'

const WORKSPACE_CLEANUP_CLOSE_LINGER_MS = 300

export type WorkspaceCleanupDialogLifecycle = {
  open: boolean
  mountedContent: boolean
  loading: boolean
  closeModal: () => void
  /** Host-qualified row identities, not worktree ids (STA-4343). */
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  removal: WorkspaceCleanupRemovalController
  startWorkspaceCleanupScan: (options?: { notifyWhenReady?: boolean }) => void
}

/** Keeps scan/removal ownership mounted while the closed dialog drops its projection tree. */
export function useWorkspaceCleanupDialogLifecycle(): WorkspaceCleanupDialogLifecycle {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const loading = useAppStore((s) => s.workspaceCleanupLoading)
  const open = activeModal === 'workspace-cleanup'
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  const deselectRemovedIdentities = useCallback((removedIdentities: readonly string[]) => {
    if (removedIdentities.length === 0) {
      return
    }
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const identity of removedIdentities) {
        next.delete(identity)
      }
      return next
    })
  }, [])
  const removal = useWorkspaceCleanupRemoval({
    onDeselect: deselectRemovedIdentities,
    closeModal
  })
  const { removalInFlightRef, resetForReopen, resetRowFailures } = removal

  const onFreshOpen = useCallback(() => {
    if (!removalInFlightRef.current) {
      resetForReopen()
      setSelectedIds(new Set())
    }
  }, [removalInFlightRef, resetForReopen])

  const { startWorkspaceCleanupScan } = useWorkspaceCleanupScanLifecycle({
    open,
    loading,
    removalInFlight: removal.removalInFlight,
    removalInFlightRef,
    resetRowFailures,
    onFreshOpen
  })
  const [mountedContent, setMountedContent] = useState(open)
  useEffect(() => {
    if (open) {
      setMountedContent(true)
      return
    }
    const timer = window.setTimeout(
      () => setMountedContent(false),
      WORKSPACE_CLEANUP_CLOSE_LINGER_MS
    )
    return () => window.clearTimeout(timer)
  }, [open])

  return {
    open,
    mountedContent,
    loading,
    closeModal,
    selectedIds,
    setSelectedIds,
    removal,
    startWorkspaceCleanupScan
  }
}
