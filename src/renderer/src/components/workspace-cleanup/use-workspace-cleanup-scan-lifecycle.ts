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

/**
 * Owns the dialog's scan cadence: seed the list from the persisted snapshot,
 * kick one background rescan per open, and adopt — never duplicate — a scan
 * already streaming into the store when the dialog reopens mid-flight.
 */
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
    // Why: the cached snapshot must seed the list before the rescan starts so
    // progress reconciles into full rows instead of a cold rebuild.
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
    // Why: reopening mid-batch keeps the deletion progress view; a broad scan
    // started here would be discarded by the removal's scan invalidation, so
    // skip it while a removal batch is running.
    if (removalInFlight || removalInFlightRef.current) {
      return
    }
    if (autoScanAttemptedForOpenRef.current) {
      return
    }
    autoScanAttemptedForOpenRef.current = true
    if (loading) {
      // Why: reopening mid-scan adopts the stream already feeding the store;
      // starting another broad scan here would duplicate it once it settles.
      return
    }
    hydrateThenScan()
  }, [hydrateThenScan, loading, onFreshOpen, open, removalInFlight, removalInFlightRef])

  return { startWorkspaceCleanupScan }
}
