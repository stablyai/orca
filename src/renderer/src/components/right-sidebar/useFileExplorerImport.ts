import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { translate } from '@/i18n/i18n'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import { captureFileExplorerOperationGuard } from './file-explorer-operation-owner'

type UseFileExplorerImportParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  refreshDir: (dirPath: string) => Promise<void>
  clearNativeDragState: () => void
  setSelectedPath: (path: string | null) => void
  operationOwner?: FileExplorerOperationOwner
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
  setSelectedPath,
  operationOwner
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
  const operationOwnerRef = useRef(operationOwner)
  operationOwnerRef.current = operationOwner

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

      void (async () => {
        try {
          const operationGuard = captureFileExplorerOperationGuard(wtId, operationOwnerRef.current)
          operationGuard.assertCurrent()
          const { results } = await importExternalPathsToRuntime(
            {
              settings: operationGuard.route.settings,
              worktreeId: wtId,
              worktreePath: worktreePathRef.current,
              connectionId: operationGuard.route.connectionId,
              expectedExecutionHostId: operationGuard.route.expectedExecutionHostId,
              expectedSshTargetId: operationGuard.route.expectedSshTargetId,
              expectedSshConnectionGeneration: operationGuard.route.expectedSshConnectionGeneration
            },
            paths,
            destinationDir,
            { assertCurrent: operationGuard.assertCurrent }
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
