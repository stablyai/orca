import type React from 'react'
import type { RefObject } from 'react'
import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { Repo } from '../../../../shared/repo-types'
import {
  buildAddProjectFromFolderModalData,
  canShowAddAsProjectAction
} from './file-explorer-add-project-action'
import {
  isRenameHotspotTarget,
  resolveDirToggleTiming,
  type DirToggleTiming
} from './file-explorer-dir-toggle-timing'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { FileExplorerSelectionMode } from './file-explorer-selection'
import { folderRelativePathToIncludeGlob } from './file-search-include-pattern'
import type { InlineInput } from './file-explorer-inline-input-row'
import type { TreeNode } from './file-explorer-types'
import { useFileDuplicate } from './useFileDuplicate'
import { useFileExplorerKeys } from './useFileExplorerKeys'
import { shouldShowOpenInDefaultAppAction } from './file-explorer-row-action-visibility'
import { openFileInDefaultApp } from './file-explorer-row-file-transfer'

type UseFileExplorerNodeCommandsParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  activeRepo: Repo | null
  runtimeDownloadContext: RuntimeFileOperationArgs | null
  containerRef: RefObject<HTMLDivElement | null>
  rowProjection: FileExplorerRowProjection
  rowExpandedPaths: Set<string>
  selectedPaths: Set<string>
  selectedNode: TreeNode | null
  selectRowWithModifiers: (
    node: TreeNode,
    event: React.MouseEvent<HTMLButtonElement>,
    onReplaceClick: (node: TreeNode) => void
  ) => void
  moveSelection: (targetPath: string, mode: FileExplorerSelectionMode) => void
  inlineInput: InlineInput | null
  startRename: (node: TreeNode) => void
  requestDelete: (node: TreeNode) => void
  requestDeleteAll: (nodes: TreeNode[]) => void
  refreshDir: (dirPath: string) => Promise<void>
  handleClick: (node: TreeNode, dirToggle?: DirToggleTiming) => void
  cancelPendingDirToggle: () => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  scrollToIndex: (index: number) => void
}

type UseFileExplorerNodeCommandsResult = {
  handleStartRename: (node: TreeNode) => void
  handleContextMenuDelete: (node: TreeNode) => void
  handleDuplicate: (node: TreeNode) => void
  handleRowClick: (node: TreeNode, event: React.MouseEvent<HTMLButtonElement>) => void
  handleCollapseFolderSubtree: (node: TreeNode) => void
  handleFindInFolder: (node: TreeNode) => void
  handleAddFolderAsProject: (node: TreeNode) => void
  handleOpenInTerminal: (node: TreeNode) => void
}

/** Command layer over a TreeNode, plus the keyboard binding of those same commands. */
export function useFileExplorerNodeCommands({
  activeWorktreeId,
  worktreePath,
  activeRepo,
  runtimeDownloadContext,
  containerRef,
  rowProjection,
  rowExpandedPaths,
  selectedPaths,
  selectedNode,
  selectRowWithModifiers,
  moveSelection,
  inlineInput,
  startRename,
  requestDelete,
  requestDeleteAll,
  refreshDir,
  handleClick,
  cancelPendingDirToggle,
  toggleDir,
  scrollToIndex
}: UseFileExplorerNodeCommandsParams): UseFileExplorerNodeCommandsResult {
  const collapseDirSubtree = useAppStore((s) => s.collapseDirSubtree)
  const openModal = useAppStore((s) => s.openModal)
  const showRightSidebarSearch = useAppStore((s) => s.showRightSidebarSearch)

  const selectedNodes = useMemo(
    () => rowProjection.getRowsByPaths(selectedPaths),
    [rowProjection, selectedPaths]
  )

  // Why: pass a stable activator so arrow-key navigation can hand the same
  // activate-toggles-folder / open-file-preview behavior the click handler
  // already uses, without the keyboard path re-implementing symlink handling.
  const activateNode = useCallback(
    (node: TreeNode) => {
      void handleClick(node)
    },
    [handleClick]
  )
  // Why: a rename can start while a name click is still holding back its
  // directory toggle; drop it so the tree doesn't shift under the input.
  const handleStartRename = useCallback(
    (node: TreeNode) => {
      cancelPendingDirToggle()
      startRename(node)
    },
    [cancelPendingDirToggle, startRename]
  )
  const handleOpenInDefaultApp = useCallback(
    (node: TreeNode): boolean => {
      if (
        !shouldShowOpenInDefaultAppAction(
          node,
          activeRepo?.connectionId ?? null,
          runtimeDownloadContext
        )
      ) {
        return false
      }
      if (
        isLocalPathOpenBlocked(useAppStore.getState().settings, {
          connectionId: activeRepo?.connectionId ?? null
        })
      ) {
        showLocalPathOpenBlockedToast()
        return false
      }
      void openFileInDefaultApp(node)
      return true
    },
    [activeRepo?.connectionId, runtimeDownloadContext]
  )

  useFileExplorerKeys({
    containerRef,
    rowProjection,
    expandedPaths: rowExpandedPaths,
    canToggleDirectories: true,
    inlineInput,
    selectedPaths,
    selectedNode,
    activateNode,
    moveSelection,
    toggleDir,
    startRename: handleStartRename,
    openInDefaultApp: handleOpenInDefaultApp,
    requestDelete,
    requestDeleteAll,
    scrollToIndex,
    activeWorktreeId
  })

  // Why: context-menu Delete should respect the multi-selection — if the
  // right-clicked node is already part of a multi-selection, delete the whole
  // set; otherwise fall through to single-node delete.
  const handleContextMenuDelete = useCallback(
    (node: TreeNode) => {
      if (selectedPaths.has(node.path) && selectedNodes.length > 1) {
        requestDeleteAll(selectedNodes)
      } else {
        requestDelete(node)
      }
    },
    [selectedPaths, selectedNodes, requestDelete, requestDeleteAll]
  )

  const handleDuplicate = useFileDuplicate({ activeWorktreeId, worktreePath, refreshDir })
  const handleRowClick = useCallback(
    (node: TreeNode, event: React.MouseEvent<HTMLButtonElement>) => {
      const dirToggle = resolveDirToggleTiming({
        fromRenameHotspot: isRenameHotspotTarget(event.target),
        clickCount: event.detail
      })
      selectRowWithModifiers(node, event, (target) => handleClick(target, dirToggle))
    },
    [handleClick, selectRowWithModifiers]
  )
  const handleCollapseFolderSubtree = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      collapseDirSubtree(activeWorktreeId, node.path)
    },
    [activeWorktreeId, collapseDirSubtree]
  )
  const handleFindInFolder = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      showRightSidebarSearch({
        includePattern: folderRelativePathToIncludeGlob(node.relativePath)
      })
    },
    [activeWorktreeId, showRightSidebarSearch]
  )

  const handleAddFolderAsProject = useCallback(
    (node: TreeNode) => {
      if (!activeRepo || !canShowAddAsProjectAction(node, activeRepo)) {
        return
      }
      openModal(
        'confirm-add-project-from-folder',
        buildAddProjectFromFolderModalData(node, activeRepo)
      )
    },
    [activeRepo, openModal]
  )
  const handleOpenInTerminal = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      createNewTerminalTab(activeWorktreeId, undefined, { startupCwd: node.path })
    },
    [activeWorktreeId]
  )

  return {
    handleStartRename,
    handleContextMenuDelete,
    handleDuplicate,
    handleRowClick,
    handleCollapseFolderSubtree,
    handleFindInFolder,
    handleAddFolderAsProject,
    handleOpenInTerminal
  }
}
