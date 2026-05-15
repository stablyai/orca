import { useCallback, useMemo, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { dirname } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import type { TreeNode } from './file-explorer-types'
import {
  requestEditorFileSave,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import {
  deleteRuntimePath,
  isRemoteRuntimeFileOperation,
  readRuntimeFileContent,
  writeRuntimeFile
} from '@/runtime/runtime-file-client'

type UseFileDeletionParams = {
  activeWorktreeId: string | null
  openFiles: {
    id: string
    filePath: string
    isDirty?: boolean
  }[]
  closeFile: (fileId: string) => void
  refreshDir: (dirPath: string) => Promise<void>
  selectedPath: string | null
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  isMac: boolean
  isWindows: boolean
}

type UseFileDeletionResult = {
  deleteShortcutLabel: string
  requestDelete: (node: TreeNode) => void
}

export function useFileDeletion({
  activeWorktreeId,
  openFiles,
  closeFile,
  refreshDir,
  selectedPath,
  setSelectedPath,
  isMac,
  isWindows
}: UseFileDeletionParams): UseFileDeletionResult {
  // Why: track in-flight deletes per-path so repeated Del presses on the same
  // node don't issue duplicate IPC calls; the map is a ref to avoid re-renders.
  const inFlightRef = useRef<Set<string>>(new Set())

  const runDelete = useCallback(
    async (node: TreeNode) => {
      if (inFlightRef.current.has(node.path)) {
        return
      }
      inFlightRef.current.add(node.path)

      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      const state = useAppStore.getState()
      const worktree = activeWorktreeId
        ? findWorktreeById(state.worktreesByRepo, activeWorktreeId)
        : null
      const fileContext = {
        settings: state.settings,
        worktreeId: activeWorktreeId,
        worktreePath: worktree?.path ?? null,
        connectionId
      }
      const isRemote =
        connectionId !== undefined || isRemoteRuntimeFileOperation(fileContext, node.path)

      // Why: remote deletes go through `rm` on the relay — there is no OS-level
      // Trash/Recycle Bin, so the operation is permanent. Require an explicit
      // confirmation in that case because the UI's usual undo cannot restore
      // directories or binary files.
      if (isRemote) {
        const message = node.isDirectory
          ? `Permanently delete '${node.name}' and all its contents? This cannot be undone.`
          : `Permanently delete '${node.name}'? This cannot be undone.`
        if (!window.confirm(message)) {
          inFlightRef.current.delete(node.path)
          return
        }
      }

      try {
        const filesToClose = openFiles.filter((file) =>
          isPathEqualOrDescendant(file.filePath, node.path)
        )
        // Why: force-save any dirty buffers before trashing so the undo snapshot
        // reads the user's latest edits from disk — not an older version that
        // predates debounced autosave or a buffer with autosave disabled.
        // Quiesce-only would cancel pending timers and discard those edits.
        // If a save fails, surface the error and abort the delete instead of
        // silently trashing the stale on-disk content.
        const dirtyFiles = filesToClose.filter((file) => file.isDirty)
        await Promise.all(dirtyFiles.map((file) => requestEditorFileSave({ fileId: file.id })))
        // After saving, quiesce any remaining scheduled autosaves so trailing
        // writes cannot recreate the file after it's been trashed.
        await Promise.all(filesToClose.map((file) => requestEditorSaveQuiesce({ fileId: file.id })))

        const parentDir = dirname(node.path)
        // Why: read file content before deleting so undo can restore it.
        // We capture content first but only commit the undo entry after the
        // delete succeeds — otherwise a failed delete would poison the stack.
        let undoContent: string | undefined
        if (!node.isDirectory) {
          try {
            const rf = await readRuntimeFileContent({
              settings: fileContext.settings,
              filePath: node.path,
              relativePath: node.relativePath,
              worktreeId: activeWorktreeId ?? undefined,
              connectionId
            })
            if (!rf.isBinary) {
              undoContent = rf.content
            }
          } catch {
            // If we cannot read the file (race, permission), skip undo recording
            // so a failed undo cannot restore stale content.
          }
        }

        await deleteRuntimePath(fileContext, node.path, node.isDirectory)

        if (undoContent !== undefined) {
          commitFileExplorerOp({
            undo: async () => {
              await writeRuntimeFile(fileContext, node.path, undoContent)
              await refreshDir(parentDir)
            },
            redo: async () => {
              await deleteRuntimePath(fileContext, node.path, node.isDirectory)
              await refreshDir(parentDir)
            }
          })
        }

        for (const file of filesToClose) {
          closeFile(file.id)
        }

        if (activeWorktreeId) {
          useAppStore.setState((state) => {
            const currentExpanded = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
            const nextExpanded = new Set(
              Array.from(currentExpanded).filter(
                (dirPath) => !isPathEqualOrDescendant(dirPath, node.path)
              )
            )

            if (nextExpanded.size === currentExpanded.size) {
              return state
            }

            return {
              expandedDirs: {
                ...state.expandedDirs,
                [activeWorktreeId]: nextExpanded
              }
            }
          })
        }

        if (selectedPath && isPathEqualOrDescendant(selectedPath, node.path)) {
          setSelectedPath(null)
        }
        // Why: use targeted refreshDir instead of refreshTree so only the parent
        // directory is reloaded, preserving scroll position and avoiding redundant
        // full-tree reloads (the watcher will also trigger a targeted refresh).
        await refreshDir(dirname(node.path))

        // Why: local deletes go to the OS trash and are recoverable; remote
        // deletes call `rm` on the relay and are permanent. The toast needs
        // to reflect that so users aren't misled into thinking they can
        // recover a remote file from a Trash/Recycle Bin that doesn't exist.
        if (isRemote) {
          toast.success(`'${node.name}' deleted`)
        } else {
          const destination = isWindows ? 'Recycle Bin' : 'Trash'
          toast.success(`'${node.name}' moved to ${destination}`)
        }
      } catch (error) {
        const action = isRemote ? 'delete' : isWindows ? 'move to Recycle Bin' : 'move to Trash'
        toast.error(error instanceof Error ? error.message : `Failed to ${action} '${node.name}'.`)
      } finally {
        inFlightRef.current.delete(node.path)
      }
    },
    [activeWorktreeId, closeFile, isWindows, openFiles, refreshDir, selectedPath, setSelectedPath]
  )

  const requestDelete = useCallback(
    (node: TreeNode) => {
      setSelectedPath(node.path)
      // Why: local deletes skip confirmation because they're reversible
      // (OS-level Trash + in-app undo). Remote deletes are permanent, so
      // runDelete prompts for confirmation internally before calling `rm`.
      void runDelete(node)
    },
    [runDelete, setSelectedPath]
  )

  return useMemo(
    () => ({
      deleteShortcutLabel: isMac ? '⌘⌫ / Del' : 'Del',
      requestDelete
    }),
    [isMac, requestDelete]
  )
}
