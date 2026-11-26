import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import {
  WORKSPACE_FILE_PATH_MIME,
  writeWorkspaceFileDragSourceIfResolved
} from '@/lib/files/drop/workspace-file-drag'
import type { LocalPathOpenOwner } from '@/lib/files/os-open/local-path-open-guard'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { getFileExplorerOperationExecutionHostId } from '../navigation/file-explorer-operation-owner'
import { formatFileExplorerPathsForClipboard } from '../selection/file-explorer-selection'
import type { FileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import type { TreeNode } from '../tree/file-explorer-types'

export type NameMatchRowActions = {
  open: (node: TreeNode, permanent: boolean) => void
  copyPaths: (node: TreeNode, pathKind: 'absolute' | 'relative') => void
  startNew: (type: 'file' | 'folder', dir: string, depth: number) => void
  startRename: (node: TreeNode) => void
  duplicate: (node: TreeNode) => void
  requestDelete: (node: TreeNode) => void
  dragStart: (event: React.DragEvent<HTMLElement>, node: TreeNode) => void
  canOpenInOrcaBrowser: (path: string) => boolean
  deleteShortcutLabel: string
  connectionId: string | null
  runtimeDownloadContext: RuntimeFileOperationArgs | null
}

type PendingTreeAction = { path: string; run: (row: TreeNode) => void }

/** Tree actions for flat name rows; anything that edits inline first clears the query and reveals the row. */
export function useNameMatchRowActions({
  activeWorktreeId,
  searchActive,
  clearSearch,
  rowProjection,
  pathOwner,
  sourceWorkspaceId,
  connectionId,
  runtimeDownloadContext,
  deleteShortcutLabel,
  canOpenInOrcaBrowser,
  openNode,
  pinNode,
  startNewInTree,
  startRenameInTree,
  duplicate,
  requestDelete
}: {
  activeWorktreeId: string | null
  searchActive: boolean
  clearSearch: () => void
  rowProjection: FileExplorerRowProjection
  pathOwner: LocalPathOpenOwner
  sourceWorkspaceId: string | null
  connectionId: string | null
  runtimeDownloadContext: RuntimeFileOperationArgs | null
  deleteShortcutLabel: string
  canOpenInOrcaBrowser: (path: string) => boolean
  openNode: (node: TreeNode) => void
  pinNode: (node: TreeNode) => void
  startNewInTree: (type: 'file' | 'folder', dir: string, depth: number) => void
  startRenameInTree: (node: TreeNode) => void
  duplicate: (node: TreeNode) => void
  requestDelete: (node: TreeNode) => void
}): NameMatchRowActions {
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)
  const [pendingTreeAction, setPendingTreeAction] = useState<PendingTreeAction | null>(null)

  useEffect(() => {
    if (!pendingTreeAction || searchActive) {
      return
    }
    const row = rowProjection.getRowByPath(pendingTreeAction.path)
    if (row) {
      setPendingTreeAction(null)
      pendingTreeAction.run(row)
    }
  }, [pendingTreeAction, rowProjection, searchActive])

  const revealThen = useCallback(
    (path: string, run: (row: TreeNode) => void) => {
      if (!activeWorktreeId) {
        return
      }
      clearSearch()
      revealInExplorer(activeWorktreeId, path)
      setPendingTreeAction({ path, run })
    },
    [activeWorktreeId, clearSearch, revealInExplorer]
  )

  const open = useCallback(
    (node: TreeNode, permanent: boolean) => {
      openNode(node)
      if (permanent) {
        pinNode(node)
      }
    },
    [openNode, pinNode]
  )
  const copyPaths = useCallback(
    (node: TreeNode, pathKind: 'absolute' | 'relative') => {
      // Why: the hidden tree's selection must not widen a copy from one search row.
      void window.api.ui.writeClipboardText(
        formatFileExplorerPathsForClipboard([node], pathKind, pathOwner)
      )
    },
    [pathOwner]
  )
  const startNew = useCallback(
    (type: 'file' | 'folder', dir: string, depth: number) =>
      revealThen(dir, () => startNewInTree(type, dir, depth)),
    [revealThen, startNewInTree]
  )
  const startRename = useCallback(
    (node: TreeNode) => revealThen(node.path, (row) => startRenameInTree(row)),
    [revealThen, startRenameInTree]
  )
  const dragStart = useCallback(
    (event: React.DragEvent<HTMLElement>, node: TreeNode) => {
      event.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, node.path)
      const owner = node.operationOwner
      writeWorkspaceFileDragSourceIfResolved(
        event.dataTransfer,
        sourceWorkspaceId,
        getFileExplorerOperationExecutionHostId(owner),
        owner?.kind === 'runtime' ? owner.environmentId : undefined
      )
      event.dataTransfer.effectAllowed = 'copyMove'
    },
    [sourceWorkspaceId]
  )

  return useMemo(
    () => ({
      open,
      copyPaths,
      startNew,
      startRename,
      duplicate,
      requestDelete,
      dragStart,
      canOpenInOrcaBrowser,
      deleteShortcutLabel,
      connectionId,
      runtimeDownloadContext
    }),
    [
      canOpenInOrcaBrowser,
      connectionId,
      copyPaths,
      deleteShortcutLabel,
      dragStart,
      duplicate,
      open,
      requestDelete,
      runtimeDownloadContext,
      startNew,
      startRename
    ]
  )
}
