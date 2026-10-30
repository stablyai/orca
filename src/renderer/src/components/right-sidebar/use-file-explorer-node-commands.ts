import type React from 'react'
import type { RefObject } from 'react'
import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'
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
import { isFileExplorerNodeReadOnly } from './file-explorer-row-action-visibility'
import type { LocalPathOpenOwner } from '@/lib/local-path-open-guard'

type UseFileExplorerNodeCommandsParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  activeRepo: Repo | null
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
  toggleDir: (worktreeId: string, dirPath: string) => void
  scrollToIndex: (index: number) => void
  readOnly?: boolean
  pathOwner: LocalPathOpenOwner
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

export function useFileExplorerNodeCommands({
  activeWorktreeId,
  worktreePath,
  activeRepo,
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
  toggleDir,
  scrollToIndex,
  readOnly = false,
  pathOwner
}: UseFileExplorerNodeCommandsParams): UseFileExplorerNodeCommandsResult {
  const collapseDirSubtree = useAppStore((s) => s.collapseDirSubtree)
  const openModal = useAppStore((s) => s.openModal)
  const showRightSidebarSearch = useAppStore((s) => s.showRightSidebarSearch)

  const selectedNodes = useMemo(
    () => rowProjection.getRowsByPaths(selectedPaths),
    [rowProjection, selectedPaths]
  )
  const isReadOnlyNode = useCallback(
    (node: TreeNode) => isFileExplorerNodeReadOnly(node, worktreePath, readOnly),
    [readOnly, worktreePath]
  )

  // Share click activation with keyboard navigation, including symlink handling.
  const activateNode = useCallback(
    (node: TreeNode) => {
      void handleClick(node)
    },
    [handleClick]
  )
  useFileExplorerKeys({
    containerRef,
    rowProjection,
    expandedPaths: rowExpandedPaths,
    canToggleDirectories: true,
    canMutate: !readOnly,
    canMutateNode: (node) => !isReadOnlyNode(node),
    canCopyRelativePathNode: (node) => !isReadOnlyNode(node),
    inlineInput,
    selectedPaths,
    selectedNode,
    activateNode,
    moveSelection,
    toggleDir,
    startRename: (node) => {
      if (!isReadOnlyNode(node)) {
        startRename(node)
      }
    },
    requestDelete: (node) => {
      if (!isReadOnlyNode(node)) {
        requestDelete(node)
      }
    },
    requestDeleteAll: (nodes) => {
      if (!nodes.some(isReadOnlyNode)) {
        requestDeleteAll(nodes)
      }
    },
    scrollToIndex,
    activeWorktreeId,
    pathOwner
  })

  // Delete the multi-selection only when the context-menu target belongs to it.
  const handleContextMenuDelete = useCallback(
    (node: TreeNode) => {
      const targets =
        selectedPaths.has(node.path) && selectedNodes.length > 1 ? selectedNodes : [node]
      if (targets.some(isReadOnlyNode)) {
        return
      }
      if (targets.length > 1) {
        requestDeleteAll(targets)
      } else {
        requestDelete(node)
      }
    },
    [isReadOnlyNode, selectedNodes, selectedPaths, requestDelete, requestDeleteAll]
  )

  const duplicateFile = useFileDuplicate({ activeWorktreeId, worktreePath, refreshDir })
  const handleDuplicate = useCallback(
    (node: TreeNode) => {
      if (!isReadOnlyNode(node)) {
        duplicateFile(node)
      }
    },
    [duplicateFile, isReadOnlyNode]
  )
  const handleStartRename = useCallback(
    (node: TreeNode) => {
      if (!isReadOnlyNode(node)) {
        startRename(node)
      }
    },
    [isReadOnlyNode, startRename]
  )
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
      if (isReadOnlyNode(node) || !activeWorktreeId || !node.isDirectory) {
        return
      }
      showRightSidebarSearch({
        includePattern: folderRelativePathToIncludeGlob(node.relativePath)
      })
    },
    [activeWorktreeId, isReadOnlyNode, showRightSidebarSearch]
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
      if (isReadOnlyNode(node) || !activeWorktreeId || !node.isDirectory) {
        return
      }
      createNewTerminalTab(activeWorktreeId, undefined, { startupCwd: node.path })
    },
    [activeWorktreeId, isReadOnlyNode]
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
