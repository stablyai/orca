import { useCallback } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

/** Workspace size measuring: the store's scan state plus a runner that reports failures as a toast. */
export function useWorkspaceCleanupSpaceScan(): {
  runSpaceScan: () => void
  scanning: boolean
  progress: ReturnType<typeof useAppStore.getState>['workspaceSpaceScanProgress']
  error: string | null
} {
  const refreshWorkspaceSpace = useAppStore((s) => s.refreshWorkspaceSpace)
  const scanning = useAppStore((s) => s.workspaceSpaceScanning)
  const progress = useAppStore((s) => s.workspaceSpaceScanProgress)
  const error = useAppStore((s) => s.workspaceSpaceScanError)
  const mountedRef = useMountedRef()
  const runSpaceScan = useCallback(() => {
    void refreshWorkspaceSpace().catch((scanError: unknown) => {
      if (!mountedRef.current) {
        return
      }
      toast.error(
        translate(
          'components.workspace.cleanup.browse.measureSizesFailed',
          'Could not scan workspace sizes'
        ),
        {
          description: scanError instanceof Error ? scanError.message : String(scanError)
        }
      )
    })
  }, [mountedRef, refreshWorkspaceSpace])
  return { runSpaceScan, scanning, progress, error }
}
