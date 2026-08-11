import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'

export function useWorkspaceCleanupScanSession({
  open,
  mountedRef,
  openModal,
  scanWorkspaceCleanup,
  clearRowFailures
}: {
  open: boolean
  mountedRef: RefObject<boolean>
  openModal: AppState['openModal']
  scanWorkspaceCleanup: AppState['scanWorkspaceCleanup']
  clearRowFailures: () => void
}): (options?: { notifyWhenReady?: boolean }) => void {
  const openRef = useRef(open)
  const latestReadyToastScanAtRef = useRef<number | null>(null)

  useEffect(() => {
    openRef.current = open
  }, [open])

  return useCallback(
    (options: { notifyWhenReady?: boolean } = {}) => {
      clearRowFailures()
      void scanWorkspaceCleanup()
        .then((result) => {
          if (!mountedRef.current || !options.notifyWhenReady || openRef.current) {
            return
          }
          if (latestReadyToastScanAtRef.current === result.scannedAt) {
            return
          }
          latestReadyToastScanAtRef.current = result.scannedAt
          const suggestedCount = result.candidates.filter(
            (candidate) => candidate.selectedByDefault
          ).length
          toast.success(
            translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.0e2d235c63',
              'Inactive workspace scan ready'
            ),
            {
              description: formatWorkspaceCleanupReadyToastDescription(
                result.candidates.length,
                suggestedCount
              ),
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
        .catch((error: unknown) => {
          if (!mountedRef.current) {
            return
          }
          toast.error(
            translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.662b8ec3f8',
              'Workspace cleanup scan failed'
            ),
            { description: error instanceof Error ? error.message : String(error) }
          )
        })
    },
    [clearRowFailures, mountedRef, openModal, scanWorkspaceCleanup]
  )
}

function formatWorkspaceCleanupReadyToastDescription(
  inactiveCount: number,
  suggestedCount: number
): string {
  if (inactiveCount === 0) {
    return 'No inactive workspaces found.'
  }
  const inactiveNoun = inactiveCount === 1 ? 'workspace' : 'workspaces'
  const suggestedNoun = suggestedCount === 1 ? 'suggestion' : 'suggestions'
  return `${inactiveCount} inactive ${inactiveNoun} found, with ${suggestedCount} cleanup ${suggestedNoun}.`
}
