import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { formatWorkspaceCleanupReadyToast } from './workspace-cleanup-scan-notice'
import { isWorkspaceCleanupScanSupersededError } from '@/store/slices/workspace-cleanup-broad-scan-registry'

export type WorkspaceCleanupScanLifecycle = {
  startWorkspaceCleanupScan: (options?: { notifyWhenReady?: boolean }) => void
}

/** Seed persisted rows before one rescan per open; reopening mid-stream adopts the existing scan. */
export function useWorkspaceCleanupScanLifecycle({
  open,
  loading,
  removalInFlight,
  removalInFlightRef,
  resetRowFailures,
  onFreshOpen
}: {
  open: boolean
  loading: boolean
  removalInFlight: boolean
  removalInFlightRef: { current: boolean }
  resetRowFailures: () => void
  onFreshOpen: () => void
}): WorkspaceCleanupScanLifecycle {
  const scanWorkspaceCleanup = useAppStore((s) => s.scanWorkspaceCleanup)
  const hydrateCleanupFromCache = useAppStore((s) => s.hydrateWorkspaceCleanupFromCache)
  const hydrateSpaceFromCache = useAppStore((s) => s.hydrateWorkspaceSpaceFromCache)
  const openModal = useAppStore((s) => s.openModal)
  const mountedRef = useMountedRef()
  const openRef = useRef(open)
  const wasOpenRef = useRef(false)
  const autoScanAttemptedForOpenRef = useRef(false)
  const latestReadyToastScanAtRef = useRef<number | null>(null)

  useEffect(() => {
    openRef.current = open
  }, [open])

  const startWorkspaceCleanupScan = useCallback(
    (options: { notifyWhenReady?: boolean } = {}) => {
      resetRowFailures()
      void scanWorkspaceCleanup()
        .then((result) => {
          if (!mountedRef.current || !options.notifyWhenReady || openRef.current) {
            return
          }
          if (latestReadyToastScanAtRef.current === result.scannedAt) {
            return
          }
          latestReadyToastScanAtRef.current = result.scannedAt
          toast.success(
            translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.0e2d235c63',
              'Workspace scan ready'
            ),
            {
              description: formatWorkspaceCleanupReadyToast(result.candidates.length),
              action: {
                label: translate(
                  'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4a35c08764',
                  'Review'
                ),
                onClick: () => openModal('workspace-cleanup')
              }
            }
          )
        })
        .catch((err: unknown) => {
          if (mountedRef.current && !isWorkspaceCleanupScanSupersededError(err)) {
            toast.error(
              translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.662b8ec3f8',
                'Workspace cleanup scan failed'
              ),
              { description: err instanceof Error ? err.message : String(err) }
            )
          }
        })
    },
    [mountedRef, openModal, resetRowFailures, scanWorkspaceCleanup]
  )

  const hydrateThenScan = useCallback(() => {
    // Seed cache before rescan so streamed progress merges into complete rows.
    void Promise.allSettled([hydrateCleanupFromCache(), hydrateSpaceFromCache()]).then(() => {
      startWorkspaceCleanupScan({ notifyWhenReady: true })
    })
  }, [hydrateCleanupFromCache, hydrateSpaceFromCache, startWorkspaceCleanupScan])

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      autoScanAttemptedForOpenRef.current = false
      return
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true
      autoScanAttemptedForOpenRef.current = false
      onFreshOpen()
    }
    // Reopening an active removal keeps progress; a broad scan would be immediately invalidated.
    if (removalInFlight || removalInFlightRef.current) {
      return
    }
    if (autoScanAttemptedForOpenRef.current) {
      return
    }
    autoScanAttemptedForOpenRef.current = true
    if (loading) {
      // Adopt an existing stream on reopen instead of queuing a duplicate broad scan.
      return
    }
    hydrateThenScan()
  }, [hydrateThenScan, loading, onFreshOpen, open, removalInFlight, removalInFlightRef])

  return { startWorkspaceCleanupScan }
}
