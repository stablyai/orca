import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename, dirname, joinPath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'
import { commitFileExplorerOp } from '@/components/right-sidebar/fileExplorerUndoRedo'

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

/**
 * Walk every open file whose path is `fromPath` or a descendant of it
 * and rehome it to `toPath`. Closes and re-opens each tab to preserve
 * drafts and dirty state under the new path. Directory renames remap
 * all descendants, which is why we check both `/` and `\` separators.
 */
function remapOpenTabsForRenamedPath(fromPath: string, toPath: string, worktreePath: string): void {
  const state = useAppStore.getState()
  const filesToMove = state.openFiles.filter((file) => {
    if (file.filePath === fromPath) {
      return true
    }
    return file.filePath.startsWith(`${fromPath}/`) || file.filePath.startsWith(`${fromPath}\\`)
  })

  for (const file of filesToMove) {
    const oldFilePath = file.filePath
    const suffix = oldFilePath.slice(fromPath.length)
    const updatedPath = toPath + suffix
    const updatedRelative = updatedPath.slice(worktreePath.length + 1)
    const draft = state.editorDrafts[file.id]
    const wasDirty = file.isDirty

    // Why: preview tabs use a synthetic tab id (`markdown-preview::...`) that
    // does not equal filePath. Closing by the real tab id keeps rename/move
    // remaps correct for both editable and read-only markdown preview tabs.
    state.closeFile(file.id)
    if (file.mode === 'edit') {
      state.openFile({
        filePath: updatedPath,
        relativePath: updatedRelative,
        worktreeId: file.worktreeId,
        language: detectLanguage(basename(updatedPath)),
        mode: 'edit'
      })
    } else if (file.mode === 'markdown-preview') {
      state.openMarkdownPreview(
        {
          filePath: updatedPath,
          relativePath: updatedRelative,
          worktreeId: file.worktreeId,
          language: 'markdown'
        },
        { anchor: file.markdownPreviewAnchor ?? null }
      )
    } else {
      continue
    }

    if (draft !== undefined) {
      state.setEditorDraft(updatedPath, draft)
    }
    if (wasDirty) {
      state.markFileDirty(updatedPath, true)
    }
  }
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
 *   - quiescing any in-flight autosave on open tabs under `oldPath`
 *     (so a trailing write can't recreate the old path post-rename)
 *   - remapping every affected open editor tab to the new path
 *   - committing an undo/redo pair via the file-explorer undo stack
 *   - unwrapped toast on IPC failure
 *
 * Used by the file-explorer inline rename and by double-click-rename
 * from an editor tab. Both entry points should go through here so
 * the tab-remap + quiesce behavior stays consistent.
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

  // Let any in-flight autosave under `oldPath` finish first — a trailing
  // write to the old path after rename would silently recreate it.
  const state = useAppStore.getState()
  const filesToQuiesce = state.openFiles.filter(
    (file) =>
      file.filePath === oldPath ||
      file.filePath.startsWith(`${oldPath}/`) ||
      file.filePath.startsWith(`${oldPath}\\`)
  )
  await Promise.all(filesToQuiesce.map((file) => requestEditorSaveQuiesce({ fileId: file.id })))

  try {
    await window.api.fs.rename({ oldPath, newPath, connectionId })
    remapOpenTabsForRenamedPath(oldPath, newPath, worktreePath)
    commitFileExplorerOp({
      undo: async () => {
        await window.api.fs.rename({ oldPath: newPath, newPath: oldPath, connectionId })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
        remapOpenTabsForRenamedPath(newPath, oldPath, worktreePath)
      },
      redo: async () => {
        await window.api.fs.rename({ oldPath, newPath, connectionId })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
        remapOpenTabsForRenamedPath(oldPath, newPath, worktreePath)
      }
    })
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, `Failed to rename '${existingName}'.`))
  }
  if (refreshDir) {
    await refreshDir(parentDir)
  }
}
