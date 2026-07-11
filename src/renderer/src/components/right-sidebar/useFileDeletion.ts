import { useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { dirname } from '@/lib/path'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import type { TreeNode } from './file-explorer-types'
import { getFileExplorerOperationRoute } from './file-explorer-operation-owner'
import {
  requestEditorFileSave,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import {
  deleteRuntimePath,
  readRuntimeFileContent,
  writeRuntimeFile
} from '@/runtime/runtime-file-client'
import { translate } from '@/i18n/i18n'

type UseFileDeletionParams = {
  activeWorktreeId: string | null
  openFiles: {
    id: string
    filePath: string
    isDirty?: boolean
  }[]
  closeFile: (fileId: string) => void
  refreshDir: (dirPath: string) => Promise<void>
  setSelectedPaths: (paths: Set<string>) => void
  isWindows: boolean
}

type UseFileDeletionResult = {
  deleteShortcutLabel: string
  requestDelete: (node: TreeNode) => void
  requestDeleteAll: (nodes: TreeNode[]) => void
}

export function useFileDeletion({
  activeWorktreeId,
  openFiles,
  closeFile,
  refreshDir,
  setSelectedPaths,
  isWindows
}: UseFileDeletionParams): UseFileDeletionResult {
  const confirm = useConfirmationDialog()
  const deleteShortcutLabel = useShortcutLabel('fileExplorer.delete')
  const unresolvedDeleteOwnerError = translate(
    'auto.components.right.sidebar.useFileDeletion.8b8ee9d22f',
    "Couldn't determine which host owns this file. Check the workspace connection and try again."
  )
  // Why: track in-flight deletes per-path so repeated Del presses on the same
  // node don't issue duplicate IPC calls; the map is a ref to avoid re-renders.
  const inFlightRef = useRef<Set<string>>(new Set())

  const runDelete = useCallback(
    async (node: TreeNode): Promise<boolean> => {
      if (inFlightRef.current.has(node.path)) {
        return false
      }
      inFlightRef.current.add(node.path)

      const operationOwner = node.operationOwner ?? { kind: 'unresolved' as const }
      const operationRoute = getFileExplorerOperationRoute(operationOwner)
      // Why: treat every non-local owner (ssh, runtime, unresolved) as remote
      // for confirm/error copy, then fail closed below when the route is null
      // so an unresolved owner never reaches local filesystem authorization.
      const isRemote = operationOwner.kind !== 'local'

      try {
        if (!operationRoute) {
          throw new Error(unresolvedDeleteOwnerError)
        }
        // Why: cached nodes can outlive host hydration changes; preserve the
        // listing-time owner so deletion cannot jump to a same-path file elsewhere.
        const state = useAppStore.getState()
        const worktree = activeWorktreeId ? state.getKnownWorktreeById(activeWorktreeId) : null
        const connectionId = operationRoute.connectionId
        const fileContext = {
          settings: operationRoute.settings,
          worktreeId: activeWorktreeId,
          worktreePath: worktree?.path ?? null,
          connectionId
        }
        // Why: remote deletes bypass OS Trash, and undo cannot recover
        // directories or unreadable files.
        if (isRemote) {
          const confirmed = await confirm({
            title: translate(
              'auto.components.right.sidebar.useFileDeletion.d979a4fbb5',
              "Permanently delete '{{value0}}'?",
              { value0: node.name }
            ),
            description: node.isDirectory
              ? translate(
                  'auto.components.right.sidebar.useFileDeletion.7fb9435c86',
                  'This permanently deletes the directory and its contents on the remote host. This cannot be undone.'
                )
              : translate(
                  'auto.components.right.sidebar.useFileDeletion.23e98f192f',
                  'This permanently deletes the file on the remote host. This cannot be undone.'
                ),
            confirmLabel: translate(
              'auto.components.right.sidebar.useFileDeletion.92276aceb7',
              'Delete'
            ),
            confirmVariant: 'destructive'
          })
          if (!confirmed) {
            return false
          }
        }

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

        // Why: use targeted refreshDir instead of refreshTree so only the parent
        // directory is reloaded, preserving scroll position and avoiding redundant
        // full-tree reloads (the watcher will also trigger a targeted refresh).
        await refreshDir(dirname(node.path))

        return true
      } catch (error) {
        const action = isRemote ? 'delete' : isWindows ? 'move to Recycle Bin' : 'move to Trash'
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.useFileDeletion.72691dfebc',
                "Failed to {{value0}} '{{value1}}'.",
                { value0: action, value1: node.name }
              )
        )
        return false
      } finally {
        inFlightRef.current.delete(node.path)
      }
    },
    [
      activeWorktreeId,
      closeFile,
      confirm,
      isWindows,
      openFiles,
      refreshDir,
      unresolvedDeleteOwnerError
    ]
  )

  const requestDelete = useCallback(
    (node: TreeNode) => {
      setSelectedPaths(new Set([node.path]))
      void runDelete(node).then((deleted) => {
        if (deleted) {
          setSelectedPaths(new Set())
        }
      })
    },
    [runDelete, setSelectedPaths]
  )

  const requestDeleteAll = useCallback(
    (nodes: TreeNode[]) => {
      if (nodes.length === 0) {
        return
      }
      if (nodes.length === 1) {
        requestDelete(nodes[0])
        return
      }
      // Why: skip descendants of other selected directories — deleting a parent
      // already removes the child, and issuing both requests races on the
      // now-missing path and produces spurious errors.
      const roots = nodes.filter(
        (n) =>
          !nodes.some(
            (other) =>
              other !== n && other.isDirectory && isPathEqualOrDescendant(n.path, other.path)
          )
      )
      // Why: process sequentially in the caller's tree order so each delete
      // fully settles before the next begins — this avoids concurrent writes
      // to the same parent directory and makes failure toasts deterministic.
      // Selection is cleared once after the entire batch settles rather than
      // per-node, so no concurrent completion can restore a partial stale set.
      void (async () => {
        const deletedRoots: TreeNode[] = []
        for (const node of roots) {
          if (await runDelete(node)) {
            deletedRoots.push(node)
          }
        }
        if (deletedRoots.length === 0) {
          return
        }
        setSelectedPaths(
          new Set(
            nodes
              .filter(
                (node) =>
                  !deletedRoots.some((deleted) => isPathEqualOrDescendant(node.path, deleted.path))
              )
              .map((node) => node.path)
          )
        )
      })()
    },
    [runDelete, requestDelete, setSelectedPaths]
  )

  return useMemo(
    () => ({
      deleteShortcutLabel,
      requestDelete,
      requestDeleteAll
    }),
    [deleteShortcutLabel, requestDelete, requestDeleteAll]
  )
}
