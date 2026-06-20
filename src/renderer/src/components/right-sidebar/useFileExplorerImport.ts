import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { translate } from '@/i18n/i18n'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

type UseFileExplorerImportParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  refreshDir: (dirPath: string) => Promise<void>
  clearNativeDragState: () => void
  setSelectedPath: (path: string | null) => void
}

/**
 * Subscribes to native file-drop events targeted at the file explorer and
 * runs the import pipeline: copy into worktree, refresh, reveal.
 *
 * Why this is a separate hook: the actual filesystem paths from native OS
 * drops are only available through the preload-relayed IPC event, not the
 * React drop handler. The drop handler manages visual state; this hook
 * manages the import action.
 */
export function useFileExplorerImport({
  worktreePath,
  activeWorktreeId,
  refreshDir,
  clearNativeDragState,
  setSelectedPath
}: UseFileExplorerImportParams): void {
  // Refs to avoid re-subscribing IPC listener on every render
  const worktreePathRef = useRef(worktreePath)
  worktreePathRef.current = worktreePath
  const activeWorktreeIdRef = useRef(activeWorktreeId)
  activeWorktreeIdRef.current = activeWorktreeId
  const refreshDirRef = useRef(refreshDir)
  refreshDirRef.current = refreshDir
  const clearNativeDragStateRef = useRef(clearNativeDragState)
  clearNativeDragStateRef.current = clearNativeDragState
  const setSelectedPathRef = useRef(setSelectedPath)
  setSelectedPathRef.current = setSelectedPath

  useEffect(() => {
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== 'file-explorer') {
        return
      }

      const wtId = activeWorktreeIdRef.current
      if (!wtId || !worktreePathRef.current) {
        // Why: the preload stops propagation of the native drop event, so
        // React onDrop handlers never fire. We must clear the drag highlight
        // ourselves even when we bail out, otherwise the explorer stays stuck
        // in its drag-over visual state.
        clearNativeDragStateRef.current()
        return
      }

      const { paths, destinationDir } = data
      const connectionId = getConnectionId(wtId) ?? undefined

      void (async () => {
        try {
          const { results } = await importExternalPathsToRuntime(
            {
              settings: getRightSidebarWorktreeRuntimeSettings(wtId),
              worktreeId: wtId,
              worktreePath: worktreePathRef.current,
              connectionId
            },
            paths,
            destinationDir
          )

          // Refresh the destination directory once per gesture
          await refreshDirRef.current(destinationDir)

          // Why: only select (highlight) the first imported file — don't trigger
          // the full reveal machinery because watcher refreshes can otherwise
          // snap the tree viewport away from the user's drop target.
          const imported = results.filter((r) => r.status === 'imported')
          const skipped = results.filter((r) => r.status === 'skipped')
          const failed = results.filter((r) => r.status === 'failed')

          if (imported.length > 0) {
            setSelectedPathRef.current(imported[0].destPath)
          }

          if (failed.length > 0) {
            const noun = failed.length === 1 ? 'file' : 'files'
            toast.error(
              translate(
                'auto.components.right.sidebar.useFileExplorerImport.132fd0e1e9',
                'Failed to import {{value0}} {{value1}}.',
                { value0: failed.length, value1: noun }
              )
            )
          } else if (skipped.length > 0 && imported.length === 0) {
            const noun = skipped.length === 1 ? 'file' : 'files'
            toast.error(
              translate(
                'auto.components.right.sidebar.useFileExplorerImport.25919b2050',
                'Skipped {{value0}} {{value1}}.',
                { value0: skipped.length, value1: noun }
              )
            )
          }
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, 'Failed to import files.'))
        } finally {
          clearNativeDragStateRef.current()
        }
      })()
    })
  }, [])
}
