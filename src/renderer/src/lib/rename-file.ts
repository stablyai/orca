import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import { commitFileExplorerOp } from '@/components/right-sidebar/fileExplorerUndoRedo'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from '@/components/right-sidebar/file-explorer-operation-owner'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'

/** Strip ipcRenderer.invoke’s remote-method wrapper so toasts show the underlying error. */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type RenameFileArgs = {
  oldPath: string
  newName: string
  worktreeId: string
  worktreePath: string
  operationOwner?: FileExplorerOperationOwner
  refreshDir?: (dirPath: string) => Promise<void>
  /** The file is an open user-named document, so the rename (and its Undo) may go anywhere. */
  documentScoped?: boolean
}

/** Share explorer/editor rename transactions, undo/redo and unwrapped IPC errors; the move coordinator owns quiesce/rename/rekey and unchanged names no-op. */
export async function renameFileOnDisk(args: RenameFileArgs): Promise<void> {
  const { oldPath, newName, worktreeId, worktreePath, refreshDir } = args
  const trimmed = newName.trim()
  if (!trimmed) {
    return
  }
  const existingName = basename(oldPath)
  if (trimmed === existingName) {
    return
  }
  const parentDir = dirname(oldPath)
  const newPath = joinPath(parentDir, trimmed)
  const operationGuard = captureFileExplorerOperationGuard(
    worktreeId,
    args.operationOwner ?? getFileExplorerOperationOwner(worktreeId)
  )
  const operationRoute = operationGuard.route
  const fileContext = {
    target: operationRoute.target,
    worktreeId,
    worktreePath,
    connectionId: operationRoute.connectionId,
    expectedExecutionHostId: operationRoute.expectedExecutionHostId,
    expectedSshTargetId: operationRoute.expectedSshTargetId,
    expectedSshConnectionGeneration: operationRoute.expectedSshConnectionGeneration
  }

  try {
    operationGuard.assertCurrent()
    await executeOpenEditorPathMove({
      context: fileContext,
      fromPath: oldPath,
      toPath: newPath,
      worktreeId,
      worktreePath,
      documentScoped: args.documentScoped
    })
    commitFileExplorerOp({
      undo: async () => {
        operationGuard.assertCurrent()
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: newPath,
          toPath: oldPath,
          worktreeId,
          worktreePath,
          documentScoped: args.documentScoped
        })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
      },
      redo: async () => {
        operationGuard.assertCurrent()
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: oldPath,
          toPath: newPath,
          worktreeId,
          worktreePath,
          documentScoped: args.documentScoped
        })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
      }
    })
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, `Failed to rename '${existingName}'.`))
  }
  if (refreshDir) {
    await refreshDir(parentDir)
  }
}
