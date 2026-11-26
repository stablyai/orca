import type React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
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
  /** Stamped with the result's own workspace and listing owner, never the hidden tree's. */
  dragStart: (
    event: React.DragEvent<HTMLElement>,
    node: TreeNode,
    workspaceId: string | null
  ) => void
  canOpenInOrcaBrowser: (path: string) => boolean
  deleteShortcutLabel: string
  connectionId: string | null
  runtimeDownloadContext: RuntimeFileOperationArgs | null
}

type PendingTreeAction = { worktreeId: string; path: string; run: (row: TreeNode) => void }

function withoutTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/** Tree actions for flat name rows; anything that edits inline first clears the query and reveals the row. */
export function useNameMatchRowActions({
  activeWorktreeId,
  searchActive,
  clearSearch,
  rowProjection,
  pathOwner,
  displayRootPath,
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
  displayRootPath: string | null
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
  // A ref, not state: the action runs once its row appears and never needs to render.
  const pendingTreeActionRef = useRef<PendingTreeAction | null>(null)
  const wasSearchActiveRef = useRef(searchActive)
  useEffect(() => {
    const startedNewSearch = searchActive && !wasSearchActiveRef.current
    wasSearchActiveRef.current = searchActive
    const pending = pendingTreeActionRef.current
    // A query typed after the reveal replaces it, so its inline edit must not start later.
    // Leaving the workspace retires the action too, so a later visit never starts a stale edit.
    const leftWorkspace = pending !== null && pending.worktreeId !== activeWorktreeId
    if (startedNewSearch || leftWorkspace || !pending || searchActive) {
      if (startedNewSearch || leftWorkspace) {
        pendingTreeActionRef.current = null
      }
      return
    }
    const row = rowProjection.getRowByPath(pending.path)
    if (row) {
      pendingTreeActionRef.current = null
      pending.run(row)
    }
  }, [activeWorktreeId, rowProjection, searchActive])

  const revealThen = useCallback(
    (path: string, run: (row: TreeNode) => void) => {
      if (!activeWorktreeId) {
        return
      }
      clearSearch()
      revealInExplorer(activeWorktreeId, path)
      pendingTreeActionRef.current = { worktreeId: activeWorktreeId, path, run }
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
    (type: 'file' | 'folder', dir: string, depth: number) => {
      // The display root has no row of its own, so its inline input starts as soon as the tree shows.
      if (
        displayRootPath !== null &&
        withoutTrailingSeparators(dir) === withoutTrailingSeparators(displayRootPath)
      ) {
        clearSearch()
        pendingTreeActionRef.current = null
        startNewInTree(type, dir, depth)
        return
      }
      revealThen(dir, () => startNewInTree(type, dir, depth))
    },
    [clearSearch, displayRootPath, revealThen, startNewInTree]
  )
  const startRename = useCallback(
    (node: TreeNode) => revealThen(node.path, (row) => startRenameInTree(row)),
    [revealThen, startRenameInTree]
  )
  const dragStart = useCallback(
    (event: React.DragEvent<HTMLElement>, node: TreeNode, workspaceId: string | null) => {
      event.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, node.path)
      const owner = node.operationOwner
      writeWorkspaceFileDragSourceIfResolved(
        event.dataTransfer,
        workspaceId,
        getFileExplorerOperationExecutionHostId(owner),
        owner?.kind === 'runtime' ? owner.environmentId : undefined
      )
      event.dataTransfer.effectAllowed = 'copyMove'
    },
    []
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
