import { useCallback } from 'react'
import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import { captureFileExplorerOperationGuard } from './file-explorer-operation-owner'

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
}

export function useFileExplorerMoveDrop({
  worktreePath,
  activeWorktreeId,
  refreshDir,
  getOperationOwnerForPath,
  setDropTargetDir
}: UseFileExplorerMoveDropParams): (sourcePath: string, destDir: string) => void {
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

      const run = async (): Promise<void> => {
        try {
          const operationGuard = captureFileExplorerOperationGuard(activeWorktreeId, operationOwner)
          const operationRoute = operationGuard.route
          const fileContext = {
            settings: operationRoute.settings,
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
    [worktreePath, activeWorktreeId, refreshDir, getOperationOwnerForPath, setDropTargetDir]
  )
}
