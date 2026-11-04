import { useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { dirname } from '@/lib/path'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import { runBatchDeletion, selectDeletionRoots } from './file-explorer-batch-deletion'
import type { TreeNode } from './file-explorer-types'
import { captureFileExplorerOperationGuard } from './file-explorer-operation-owner'
import {
  getFileExplorerDeletionEditors,
  type FileExplorerDeletionEditor
} from './file-explorer-deletion-editors'
import {
  confirmRemoteDelete,
  fileDeleteFailedMessage,
  getFileDeleteErrorMessage,
  isLocalDeleteNode,
  mixedBatchDeleteDescription,
  needsRemoteDeleteConfirmation
} from './file-explorer-delete-classification'
import {
  requestEditorFileSave,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import { deleteRuntimePath, writeRuntimeFile } from '@/runtime/runtime-file-mutation-client'
import {
  assertFileWriteApplied,
  missingOrIdenticalPrecondition
} from '../../../../shared/file-write-disk-precondition'
import { deleteWithPermanentFallback } from './file-explorer-trash-fallback'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { translate } from '@/i18n/i18n'

type UseFileDeletionParams = {
  activeWorktreeId: string | null
  openFiles: FileExplorerDeletionEditor[]
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
  // Deduplicate in-flight deletes per path without rerendering.
  const inFlightRef = useRef<Set<string>>(new Set())

  const runDelete = useCallback(
    async (node: TreeNode, options?: { skipConfirmation?: boolean }): Promise<boolean> => {
      if (inFlightRef.current.has(node.path)) {
        return false
      }
      inFlightRef.current.add(node.path)

      const operationOwner = node.operationOwner ?? { kind: 'unresolved' as const }
      // Unresolved owners use remote copy and fail closed below; they must never reach local filesystem authorization.
      const isRemote = operationOwner.kind !== 'local'

      try {
        const operationGuard = captureFileExplorerOperationGuard(
          activeWorktreeId,
          node.operationOwner
        )
        // Remote deletes bypass Trash and may be unrecoverable; batches confirm once up front.
        if (isRemote && !options?.skipConfirmation) {
          const confirmed = await confirmRemoteDelete(confirm, node)
          if (!confirmed) {
            return false
          }
        }

        const operationRoute = operationGuard.assertCurrent()
        const filesToClose = getFileExplorerDeletionEditors(
          useAppStore.getState(),
          openFiles,
          node.path,
          operationRoute
        )
        // Save dirty buffers before snapshot/trash; quiescing alone would discard edits, and failed saves must abort deletion.
        const dirtyFiles = filesToClose.filter((file) => file.isDirty)
        await Promise.all(dirtyFiles.map((file) => requestEditorFileSave({ fileId: file.id })))
        // Quiesce trailing autosaves so they cannot recreate trashed files.
        await Promise.all(filesToClose.map((file) => requestEditorSaveQuiesce({ fileId: file.id })))

        // Confirmation/autosave may outlive reconnects; require the row’s original owner generation.
        operationGuard.assertCurrent()
        const state = useAppStore.getState()
        const worktree = activeWorktreeId ? state.getKnownWorktreeById(activeWorktreeId) : null
        const fileContext = {
          target: operationRoute.target,
          worktreeId: activeWorktreeId,
          worktreePath: worktree?.path ?? null,
          connectionId: operationRoute.connectionId,
          expectedExecutionHostId: operationRoute.expectedExecutionHostId,
          expectedSshTargetId: operationRoute.expectedSshTargetId,
          expectedSshConnectionGeneration: operationRoute.expectedSshConnectionGeneration
        }

        const parentDir = dirname(node.path)
        // Snapshot before deletion, but record undo only after success to avoid poisoning the stack.
        let undoContent: string | undefined
        if (!node.isDirectory) {
          try {
            const rf = await readRuntimeFileContent({
              target: fileContext.target,
              filePath: node.path,
              relativePath: node.relativePath,
              worktreeId: activeWorktreeId ?? undefined,
              connectionId: operationRoute.connectionId
            })
            if (!rf.isBinary) {
              undoContent = rf.content
            }
          } catch {
            // Unreadable snapshots cannot safely support undo.
          }
        }

        operationGuard.assertCurrent()
        const deletion = await deleteWithPermanentFallback({
          name: node.name,
          isRemote,
          isWindows,
          confirm,
          deletePath: (deleteOptions) =>
            deleteRuntimePath(fileContext, node.path, node.isDirectory, deleteOptions),
          beforePermanentDelete: () => operationGuard.assertCurrent()
        })
        if (!deletion) {
          return false
        }
        const { permanent } = deletion

        if (undoContent !== undefined) {
          commitFileExplorerOp({
            undo: async () => {
              const currentRoute = operationGuard.assertCurrent()
              // Undo must not overwrite a path recreated since deletion.
              assertFileWriteApplied(
                await writeRuntimeFile(
                  {
                    ...fileContext,
                    target: currentRoute.target,
                    connectionId: currentRoute.connectionId
                  },
                  node.path,
                  undoContent,
                  undefined,
                  missingOrIdenticalPrecondition(undoContent)
                )
              )
              await refreshDir(parentDir)
            },
            redo: async () => {
              const currentRoute = operationGuard.assertCurrent()
              await deleteRuntimePath(
                {
                  ...fileContext,
                  target: currentRoute.target,
                  connectionId: currentRoute.connectionId
                },
                node.path,
                node.isDirectory,
                { permanent }
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

        // Refresh only the parent to preserve scroll position and avoid redundant full-tree reloads.
        await refreshDir(dirname(node.path))

        return true
      } catch (error) {
        toast.error(
          getFileDeleteErrorMessage(error) ||
            fileDeleteFailedMessage(node.name, isRemote, isWindows)
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
      // Mixed batches must distinguish permanent remote deletion from local Trash.
      const hasLocalDelete = roots.some(isLocalDeleteNode)
      // Clear selection after the whole batch so concurrent completions cannot restore stale partial sets.
      void (async () => {
        const deletedRoots = await runBatchDeletion({
          roots,
          // Local Trash remains prompt-free; only remote roots need confirmation.
          needsConfirmation: roots.some(needsRemoteDeleteConfirmation),
          confirmBatch: () =>
            confirm({
              // Count selected children even when ancestor roots subsume their deletes.
              title: hasLocalDelete
                ? translate(
                    'auto.components.right.sidebar.useFileDeletion.deleteItems',
                    'Delete {{count}} items?',
                    { count: nodes.length, defaultValue_one: 'Delete {{count}} item?' }
                  )
                : translate(
                    'auto.components.right.sidebar.useFileDeletion.permanentlyDeleteItems',
                    'Permanently delete {{count}} items?',
                    { count: nodes.length, defaultValue_one: 'Permanently delete {{count}} item?' }
                  ),
              description: !hasLocalDelete
                ? translate(
                    'auto.components.right.sidebar.useFileDeletion.dd029aa5cd',
                    'This permanently deletes the selected items and any directory contents on the remote host. This cannot be undone.'
                  )
                : mixedBatchDeleteDescription(isWindows),
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
