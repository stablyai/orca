import { useCallback, type RefObject } from 'react'
import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import { captureFileExplorerOperationGuard } from './file-explorer-operation-owner'
import {
  formatFileExplorerMovePath,
  shouldConfirmFileExplorerMove,
  type FileExplorerMoveConfirmMode
} from './file-explorer-move-confirm'

function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type UseFileExplorerMoveDropParams = {
  worktreePath: string | null
  activeWorktreeId: string | null
  refreshDir: (dirPath: string) => Promise<void>
  getOperationOwnerForPath: (path: string) => FileExplorerOperationOwner | undefined
  setDropTargetDir: (dir: string | null) => void
  dragSourcePath: string | null
  dragSourceIsDirectoryRef: RefObject<boolean>
  lastDragSourceMetaRef: RefObject<{ path: string; isDirectory: boolean } | null>
}

export function useFileExplorerMoveDrop({
  worktreePath,
  activeWorktreeId,
  refreshDir,
  getOperationOwnerForPath,
  setDropTargetDir,
  dragSourcePath,
  dragSourceIsDirectoryRef,
  lastDragSourceMetaRef
}: UseFileExplorerMoveDropParams): (sourcePath: string, destDir: string) => void {
  const confirm = useConfirmationDialog()
  return useCallback(
    (sourcePath: string, destDir: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const fileName = basename(sourcePath),
        sourceDir = dirname(sourcePath)

      setDropTargetDir(null)

      if (sourceDir === destDir) {
        return
      }
      if (
        destDir === sourcePath ||
        destDir.startsWith(`${sourcePath}/`) ||
        destDir.startsWith(`${sourcePath}\\`)
      ) {
        return
      }

      const newPath = joinPath(destDir, fileName)
      const operationOwner = getOperationOwnerForPath(sourcePath)
      // Why: multi-select may drop several paths; use primary drag-source isDirectory
      // when this path is that source (or last-drag meta after capture-phase clear).
      const meta = lastDragSourceMetaRef.current
      const isDirectory =
        sourcePath === dragSourcePath
          ? dragSourceIsDirectoryRef.current
          : meta?.path === sourcePath
            ? meta.isDirectory
            : false

      const run = async (): Promise<void> => {
        const mode = (useAppStore.getState().settings?.confirmFileExplorerMove ??
          'never') as FileExplorerMoveConfirmMode
        if (shouldConfirmFileExplorerMove(mode, isDirectory)) {
          const fromLabel = formatFileExplorerMovePath(sourcePath, worktreePath)
          const toLabel = formatFileExplorerMovePath(destDir, worktreePath)
          const confirmed = await confirm({
            title: translate(
              'auto.components.right.sidebar.fileExplorer.moveConfirm.title',
              "Move '{{name}}'?",
              { name: fileName }
            ),
            description: translate(
              'auto.components.right.sidebar.fileExplorer.moveConfirm.description',
              "Move '{{from}}' into '{{to}}'.",
              { from: fromLabel, to: toLabel }
            ),
            confirmLabel: translate(
              'auto.components.right.sidebar.fileExplorer.moveConfirm.action',
              'Move'
            ),
            cancelLabel: translate(
              'auto.components.right.sidebar.fileExplorer.moveConfirm.cancel',
              'Cancel'
            )
          })
          if (!confirmed) {
            return
          }
        }

        try {
          const operationGuard = captureFileExplorerOperationGuard(activeWorktreeId, operationOwner)
          const operationRoute = operationGuard.route
          const fileContext = {
            target: operationRoute.target,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: operationRoute.connectionId,
            expectedExecutionHostId: operationRoute.expectedExecutionHostId,
            expectedSshTargetId: operationRoute.expectedSshTargetId,
            expectedSshConnectionGeneration: operationRoute.expectedSshConnectionGeneration
          }
          operationGuard.assertCurrent()
          await executeOpenEditorPathMove({
            context: fileContext,
            fromPath: sourcePath,
            toPath: newPath,
            worktreeId: activeWorktreeId,
            worktreePath
          })
          commitFileExplorerOp({
            undo: async () => {
              operationGuard.assertCurrent()
              await executeOpenEditorPathMove({
                context: fileContext,
                fromPath: newPath,
                toPath: sourcePath,
                worktreeId: activeWorktreeId,
                worktreePath
              })
              await Promise.all([refreshDir(destDir), refreshDir(sourceDir)])
            },
            redo: async () => {
              operationGuard.assertCurrent()
              await executeOpenEditorPathMove({
                context: fileContext,
                fromPath: sourcePath,
                toPath: newPath,
                worktreeId: activeWorktreeId,
                worktreePath
              })
              await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
            }
          })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, `Failed to move '${fileName}'.`))
          return
        }
        await Promise.all([refreshDir(sourceDir), refreshDir(destDir)])
      }
      void run()
    },
    [
      worktreePath,
      activeWorktreeId,
      refreshDir,
      getOperationOwnerForPath,
      setDropTargetDir,
      confirm,
      dragSourcePath,
      dragSourceIsDirectoryRef,
      lastDragSourceMetaRef
    ]
  )
}
