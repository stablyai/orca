import { useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { dirname } from '@/lib/path'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import { runBatchDeletion, selectDeletionRoots } from './file-explorer-batch-deletion'
import type { TreeNode } from './file-explorer-types'
import { captureFileExplorerOperationGuard } from './file-explorer-operation-owner'
import {
  getFileDeleteErrorMessage,
  isLocalDeleteNode,
  needsRemoteDeleteConfirmation
} from './file-explorer-delete-classification'
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
  // Why: track in-flight deletes per-path so repeated Del presses on the same
  // node don't issue duplicate IPC calls; the map is a ref to avoid re-renders.
  const inFlightRef = useRef<Set<string>>(new Set())

  const runDelete = useCallback(
    async (node: TreeNode, options?: { skipConfirmation?: boolean }): Promise<boolean> => {
      if (inFlightRef.current.has(node.path)) {
        return false
      }
      inFlightRef.current.add(node.path)

      const operationOwner = node.operationOwner ?? { kind: 'unresolved' as const }
      // Why: treat every non-local owner (ssh, runtime, unresolved) as remote
      // for confirm/error copy, then fail closed below when the route is null
      // so an unresolved owner never reaches local filesystem authorization.
      const isRemote = operationOwner.kind !== 'local'

      try {
        const operationGuard = captureFileExplorerOperationGuard(
          activeWorktreeId,
          node.operationOwner
        )
        // Why: remote deletes bypass OS Trash, and undo cannot recover
        // directories or unreadable files. Batch deletes confirm once up
        // front instead, so they skip the per-node prompt.
        if (isRemote && !options?.skipConfirmation) {
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

        // Why: confirmation and autosave can outlive a reconnect or graph replacement; mutations require the owner generation that produced the row.
        const operationRoute = operationGuard.assertCurrent()
        const state = useAppStore.getState()
        const worktree = activeWorktreeId ? state.getKnownWorktreeById(activeWorktreeId) : null
        const fileContext = {
          settings: operationRoute.settings,
          worktreeId: activeWorktreeId,
          worktreePath: worktree?.path ?? null,
          connectionId: operationRoute.connectionId,
          expectedExecutionHostId: operationRoute.expectedExecutionHostId,
          expectedSshTargetId: operationRoute.expectedSshTargetId,
          expectedSshConnectionGeneration: operationRoute.expectedSshConnectionGeneration
        }

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
              connectionId: operationRoute.connectionId
            })
            if (!rf.isBinary) {
              undoContent = rf.content
            }
          } catch {
            // If we cannot read the file (race, permission), skip undo recording
            // so a failed undo cannot restore stale content.
          }
        }

        operationGuard.assertCurrent()
        await deleteRuntimePath(fileContext, node.path, node.isDirectory)

        if (undoContent !== undefined) {
          commitFileExplorerOp({
            undo: async () => {
              const currentRoute = operationGuard.assertCurrent()
              await writeRuntimeFile(
                {
                  ...fileContext,
                  settings: currentRoute.settings,
                  connectionId: currentRoute.connectionId
                },
                node.path,
                undoContent
              )
              await refreshDir(parentDir)
            },
            redo: async () => {
              const currentRoute = operationGuard.assertCurrent()
              await deleteRuntimePath(
                {
                  ...fileContext,
                  settings: currentRoute.settings,
                  connectionId: currentRoute.connectionId
                },
                node.path,
                node.isDirectory
              )
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
        const errorMessage = getFileDeleteErrorMessage(error)
        toast.error(
          errorMessage
            ? errorMessage
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
    [activeWorktreeId, closeFile, confirm, isWindows, openFiles, refreshDir]
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
      const roots = selectDeletionRoots(nodes)
      // Why: the batch confirms whenever any root is a permanent remote delete,
      // but the selection can also include local roots that only go to the
      // Trash — so a mixed batch needs copy that keeps that distinction.
      const hasLocalDelete = roots.some(isLocalDeleteNode)
      const trashName = isWindows ? 'Recycle Bin' : 'Trash'
      // Why: selection is cleared once after the entire batch settles rather
      // than per-node, so no concurrent completion can restore a partial
      // stale set.
      void (async () => {
        const deletedRoots = await runBatchDeletion({
          roots,
          // Why: only remote deletes confirm at all — local deletes go to the
          // OS Trash and stay prompt-free in batches too.
          needsConfirmation: roots.some(needsRemoteDeleteConfirmation),
          confirmBatch: () =>
            confirm({
              // Why: count the full selection, not the filtered roots —
              // deleting a folder still deletes the selected children inside
              // it, and the prompt should match what the user sees selected.
              title: hasLocalDelete
                ? translate(
                    'auto.components.right.sidebar.useFileDeletion.77fdc36183',
                    'Delete {{count}} items?',
                    { count: nodes.length }
                  )
                : translate(
                    'auto.components.right.sidebar.useFileDeletion.af1270b90d',
                    'Permanently delete {{count}} items?',
                    { count: nodes.length }
                  ),
              description: hasLocalDelete
                ? translate(
                    'auto.components.right.sidebar.useFileDeletion.fca915a67a',
                    'Remote items are permanently deleted and cannot be undone. Local items move to the {{value0}}.',
                    { value0: trashName }
                  )
                : translate(
                    'auto.components.right.sidebar.useFileDeletion.dd029aa5cd',
                    'This permanently deletes the selected items and any directory contents on the remote host. This cannot be undone.'
                  ),
              confirmLabel: translate(
                'auto.components.right.sidebar.useFileDeletion.92276aceb7',
                'Delete'
              ),
              confirmVariant: 'destructive'
            }),
          deleteNode: (node) => runDelete(node, { skipConfirmation: true })
        })
        if (deletedRoots === null || deletedRoots.length === 0) {
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
    [confirm, isWindows, runDelete, requestDelete, setSelectedPaths]
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
