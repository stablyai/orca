import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { basename, dirname, joinPath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { commitFileExplorerOp } from '@/components/right-sidebar/fileExplorerUndoRedo'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'

/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type RenameFileArgs = {
  oldPath: string
  /** just the new filename (no directory) */
  newName: string
  worktreeId: string
  worktreePath: string
  /** refresh the parent directory in the explorer tree, if caller tracks one */
  refreshDir?: (dirPath: string) => Promise<void>
}

/**
 * Rename a file or directory on disk. Handles:
 *   - no-op when the name is unchanged
 *   - the open-editor move transaction (quiesce + rename + rekey) via the coordinator
 *   - committing an undo/redo pair via the file-explorer undo stack
 *   - unwrapped toast on IPC failure
 *
 * Used by the file-explorer inline rename and by double-click-rename
 * from an editor tab. Both go through here so the move behavior stays consistent.
 */
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
  const connectionId = getConnectionId(worktreeId) ?? undefined
  const fileContext = {
    settings: useAppStore.getState().settings,
    worktreeId,
    worktreePath,
    connectionId
  }

  try {
    await executeOpenEditorPathMove({
      context: fileContext,
      fromPath: oldPath,
      toPath: newPath,
      worktreeId,
      worktreePath
    })
    commitFileExplorerOp({
      undo: async () => {
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: newPath,
          toPath: oldPath,
          worktreeId,
          worktreePath
        })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
      },
      redo: async () => {
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: oldPath,
          toPath: newPath,
          worktreeId,
          worktreePath
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
