/* eslint-disable max-lines -- Why: FileExplorer coordinates tree data, selection, drag/drop, and virtual rows; splitting it during this merge would obscure the interaction invariants. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { basename, dirname } from '@/lib/path'
import { folderRelativePathToIncludeGlob } from './file-search-include-pattern'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { shouldResetFileExplorerForVisibleWorktree } from './file-explorer-reset'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { splitPathSegments } from './path-tree'
import { buildFolderStatusMap, buildStatusMap } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { useFileExplorerReveal } from './useFileExplorerReveal'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'
import { useFileExplorerKeys } from './useFileExplorerKeys'
import { useFileDuplicate } from './useFileDuplicate'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import { useFileExplorerImport } from './useFileExplorerImport'
import { useFileExplorerManualRefresh } from './useFileExplorerManualRefresh'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerWatch } from './useFileExplorerWatch'
import {
  buildAddProjectFromFolderModalData,
  canShowAddAsProjectAction
} from './file-explorer-add-project-action'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerSelection } from './useFileExplorerSelection'
import { useFileExplorerGitIgnoredRows } from './useFileExplorerGitIgnoredRows'

function FileExplorerInner(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const expandedDirs = useAppStore((s) => s.expandedDirs)
  const collapseAllDirs = useAppStore((s) => s.collapseAllDirs)
  const collapseDirSubtree = useAppStore((s) => s.collapseDirSubtree)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const pendingExplorerReveal = useAppStore((s) => s.pendingExplorerReveal)
  const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
  const openFile = useAppStore((s) => s.openFile)
  const pinFile = useAppStore((s) => s.pinFile)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const openModal = useAppStore((s) => s.openModal)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)

  const worktreePath = activeWorktree?.path ?? null
  const visibleWorktreePath = rightSidebarOpen ? worktreePath : null
  const repoName = activeRepo?.displayName ?? (worktreePath ? basename(worktreePath) : '')
  const activeRepoSupportsGit = activeRepo ? isGitRepoKind(activeRepo) : false

  const expanded = useMemo(
    () =>
      activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set<string>()) : new Set<string>(),
    [activeWorktreeId, expandedDirs]
  )

  const {
    dirCache,
    setDirCache,
    flatRows,
    rootCache,
    rootError,
    loadDir,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    resetAndLoad
  } = useFileExplorerTree(worktreePath, expanded, activeWorktreeId)
  const {
    visibleFlatRows,
    rowsByPath,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    toggleGitIgnoredFiles
  } = useFileExplorerGitIgnoredRows(activeWorktreeId, worktreePath, flatRows, activeRepoSupportsGit)
  const manualRefresh = useFileExplorerManualRefresh(refreshTree)
  const canCollapseAll = expanded.size > 0
  const handleCollapseAll = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    collapseAllDirs(activeWorktreeId)
  }, [activeWorktreeId, collapseAllDirs])

  const [flashingPath, setFlashingPath] = useState<string | null>(null)
  const [bgMenuOpen, setBgMenuOpen] = useState(false)
  const [bgMenuPoint, setBgMenuPoint] = useState({ x: 0, y: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Includes Radix scroll viewport + scrollbar (scrollbar is not a child of the viewport). */
  const explorerShellRef = useRef<HTMLDivElement>(null)
  const flashTimeoutRef = useRef<number | null>(null)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const isWindows = useMemo(() => navigator.userAgent.includes('Windows'), [])
  const {
    selectedPath,
    selectedPaths,
    setSingleSelectedPath,
    setSelectedPaths,
    resetSelection,
    selectRowWithModifiers,
    preserveSelectionForContextMenu,
    copyPathsForNode
  } = useFileExplorerSelection(visibleFlatRows, isMac)

  const clearFlashTimeout = useCallback(() => {
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = null
    }
  }, [])

  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )
  const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries])
  const folderStatusByRelativePath = useMemo(() => buildFolderStatusMap(entries), [entries])

  const { deleteShortcutLabel, requestDelete, requestDeleteAll } = useFileDeletion({
    activeWorktreeId,
    openFiles,
    closeFile,
    refreshDir,
    setSelectedPaths,
    isWindows
  })

  const {
    handleMoveDrop,
    handleDragExpandDir,
    dropTargetDir,
    setDropTargetDir,
    dragSourcePath,
    setDragSourcePath,
    isRootDragOver,
    isNativeDragOver,
    nativeDropTargetDir,
    setNativeDropTargetDir,
    handleNativeDragExpandDir,
    stopDragEdgeScroll,
    rootDragHandlers,
    clearNativeDragState
  } = useFileExplorerDragDrop({
    worktreePath,
    activeWorktreeId,
    expanded,
    toggleDir,
    refreshDir,
    scrollRef
  })

  const lastResetWorktreePathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!visibleWorktreePath) {
      return
    }
    // Why: the sidebar remains mounted while closed to preserve caches, but
    // loading the hidden tree would probe every clicked workspace on macOS.
    if (
      !shouldResetFileExplorerForVisibleWorktree(
        lastResetWorktreePathRef.current,
        visibleWorktreePath
      )
    ) {
      return
    }
    lastResetWorktreePathRef.current = visibleWorktreePath
    resetSelection()
    resetAndLoad()
    clearFileExplorerUndoHistory()
  }, [visibleWorktreePath, resetSelection]) // eslint-disable-line react-hooks/exhaustive-deps

  // Why: on app startup the file explorer loads before SSH providers are
  // registered, so readDir fails for remote worktrees. When the SSH
  // connection is later established, sshConnectedGeneration bumps and this
  // effect retries the load. Only retries when there was a prior error to
  // avoid redundant reloads for local worktrees.
  const sshGenRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration > sshGenRef.current) {
      sshGenRef.current = sshConnectedGeneration
      if (visibleWorktreePath && rootError) {
        resetAndLoad()
      }
    }
  }, [sshConnectedGeneration, visibleWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearFlashTimeout, [clearFlashTimeout])

  useEffect(() => {
    if (!visibleWorktreePath) {
      return
    }
    for (const dirPath of expanded) {
      if (!dirCache[dirPath]?.children.length && !dirCache[dirPath]?.loading) {
        const depth = splitPathSegments(dirPath.slice(visibleWorktreePath.length + 1)).length - 1
        void loadDir(dirPath, depth)
      }
    }
  }, [expanded, visibleWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    inlineInput,
    inlineInputIndex,
    startNew,
    startRename,
    dismissInlineInput,
    handleInlineSubmit
  } = useFileExplorerInlineInput({
    activeWorktreeId,
    worktreePath,
    expanded,
    flatRows: visibleFlatRows,
    scrollRef,
    refreshDir
  })

  useFileExplorerWatch({
    worktreePath: visibleWorktreePath,
    activeWorktreeId,
    dirCache,
    setDirCache,
    expanded,
    setSelectedPath: setSingleSelectedPath,
    refreshDir,
    refreshTree,
    inlineInput,
    dragSourcePath,
    isNativeDragOver
  })

  useFileExplorerImport({
    worktreePath,
    activeWorktreeId,
    refreshDir,
    clearNativeDragState,
    setSelectedPath: setSingleSelectedPath
  })

  const totalCount = visibleFlatRows.length + (inlineInputIndex >= 0 ? 1 : 0)

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index) => {
      if (inlineInputIndex >= 0) {
        if (index === inlineInputIndex) {
          return '__inline_input__'
        }
        const rowIndex = index > inlineInputIndex ? index - 1 : index
        return visibleFlatRows[rowIndex]?.path ?? `__fallback_${index}`
      }
      return visibleFlatRows[index]?.path ?? `__fallback_${index}`
    }
  })

  useFileExplorerReveal({
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    clearPendingExplorerReveal,
    expanded,
    dirCache,
    rootCache,
    rowsByPath,
    flatRows: visibleFlatRows,
    loadDir,
    setSelectedPath: setSingleSelectedPath,
    setFlashingPath,
    flashTimeoutRef,
    virtualizer
  })

  useFileExplorerAutoReveal({
    activeFileId,
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    openFiles,
    rowsByPath,
    flatRows: visibleFlatRows,
    setSelectedPath: setSingleSelectedPath,
    virtualizer
  })

  useEffect(() => {
    if (inlineInputIndex >= 0) {
      virtualizer.scrollToIndex(inlineInputIndex, { align: 'auto' })
    }
  }, [inlineInputIndex, virtualizer])

  const selectedNode = selectedPath ? (rowsByPath.get(selectedPath) ?? null) : null
  const selectedNodes = useMemo(
    () => visibleFlatRows.filter((row) => selectedPaths.has(row.path)),
    [visibleFlatRows, selectedPaths]
  )
  useFileExplorerKeys({
    containerRef: explorerShellRef,
    flatRows: visibleFlatRows,
    inlineInput,
    selectedPaths,
    selectedNode,
    selectedNodes,
    startRename,
    requestDelete,
    requestDeleteAll
  })

  const { handleClick, handleDoubleClick, handleWheelCapture } = useFileExplorerHandlers({
    activeWorktreeId,
    openFile,
    pinFile,
    toggleDir,
    loadDir,
    statPath,
    markPathAsDirectory,
    setSelectedPath: setSingleSelectedPath,
    scrollRef
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
    (node: (typeof visibleFlatRows)[number], event: React.MouseEvent<HTMLButtonElement>) =>
      selectRowWithModifiers(node, event, handleClick),
    [handleClick, selectRowWithModifiers]
  )
  const handleCollapseFolderSubtree = useCallback(
    (node: (typeof flatRows)[number]) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      collapseDirSubtree(activeWorktreeId, node.path)
    },
    [activeWorktreeId, collapseDirSubtree]
  )
  const seedFileSearchIncludePattern = useAppStore((s) => s.seedFileSearchIncludePattern)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const handleFindInFolder = useCallback(
    (node: (typeof flatRows)[number]) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      seedFileSearchIncludePattern(
        activeWorktreeId,
        folderRelativePathToIncludeGlob(node.relativePath)
      )
      setRightSidebarTab('search')
      setRightSidebarOpen(true)
    },
    [activeWorktreeId, seedFileSearchIncludePattern, setRightSidebarTab, setRightSidebarOpen]
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

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        Select a workspace to browse files
      </div>
    )
  }

  // Why: the root explorer container must stay mounted for loading, error,
  // and empty states so the data-native-file-drop-target marker is always
  // present. Without this, external file drops would have no target surface
  // when the tree is empty, still loading, or showing a read error.
  const isEmptyState = visibleFlatRows.length === 0 && !inlineInput
  const isLoading = isEmptyState && (rootCache?.loading ?? true)
  const hasError = isEmptyState && !isLoading && !!rootError
  const showTree = !isEmptyState

  return (
    <>
      <div
        ref={explorerShellRef}
        data-orca-explorer-shell
        data-selected-folder-relative-path={
          selectedNode?.isDirectory ? selectedNode.relativePath : undefined
        }
        className="flex h-full min-h-0 flex-col"
      >
        <FileExplorerToolbar
          repoName={repoName}
          worktreePath={worktreePath}
          connectionId={activeRepo?.connectionId ?? null}
          refresh={manualRefresh}
          canCollapseAll={canCollapseAll}
          onCollapseAll={handleCollapseAll}
          showGitIgnoredFilesToggle={activeRepoSupportsGit}
          showGitIgnoredFiles={showGitIgnoredFiles}
          onToggleGitIgnoredFiles={toggleGitIgnoredFiles}
        />
        <ScrollArea
          className={cn(
            'min-h-0 flex-1',
            isRootDragOver &&
              !(dragSourcePath && dirname(dragSourcePath) === worktreePath) &&
              'bg-border',
            isNativeDragOver && !nativeDropTargetDir && 'bg-border'
          )}
          viewportRef={scrollRef}
          viewportTabIndex={-1}
          viewportClassName="h-full min-h-0 py-2"
          data-native-file-drop-target="file-explorer"
          data-native-file-drop-dir={worktreePath}
          onWheelCapture={handleWheelCapture}
          onDragOver={rootDragHandlers.onDragOver}
          onDragEnter={rootDragHandlers.onDragEnter}
          onDragLeave={rootDragHandlers.onDragLeave}
          onDrop={rootDragHandlers.onDrop}
          onDragEnd={() => {
            stopDragEdgeScroll()
            setDropTargetDir(null)
          }}
          onContextMenu={(e) => {
            const target = e.target as HTMLElement
            if (target.closest('[data-slot="context-menu-trigger"]')) {
              return
            }
            e.preventDefault()
            setBgMenuPoint({ x: e.clientX, y: e.clientY })
            setBgMenuOpen(true)
          }}
          onDoubleClick={(e) => {
            if (!worktreePath || inlineInput) {
              return
            }
            const target = e.target as HTMLElement
            if (target.closest('[data-slot="context-menu-trigger"]')) {
              return
            }
            startNew('file', worktreePath, 0)
          }}
        >
          {!showTree && (
            <FileExplorerTreeStatus
              isLoading={isLoading}
              error={hasError ? rootError : null}
              isEmpty={isEmptyState && !isLoading && !hasError}
            />
          )}
          {showTree && (
            <FileExplorerVirtualRows
              virtualizer={virtualizer}
              inlineInputIndex={inlineInputIndex}
              flatRows={visibleFlatRows}
              inlineInput={inlineInput}
              handleInlineSubmit={handleInlineSubmit}
              dismissInlineInput={dismissInlineInput}
              folderStatusByRelativePath={folderStatusByRelativePath}
              statusByRelativePath={statusByRelativePath}
              ignoredByRelativePath={ignoredByRelativePath}
              expanded={expanded}
              dirCache={dirCache}
              selectedPaths={selectedPaths}
              activeFileId={activeFileId}
              flashingPath={flashingPath}
              deleteShortcutLabel={deleteShortcutLabel}
              onClick={handleRowClick}
              onDoubleClick={handleDoubleClick}
              onContextMenuSelect={preserveSelectionForContextMenu}
              onCopyPaths={copyPathsForNode}
              onStartNew={startNew}
              onStartRename={startRename}
              onDuplicate={handleDuplicate}
              onAddFolderAsProject={handleAddFolderAsProject}
              canAddFolderAsProject={(node) => canShowAddAsProjectAction(node, activeRepo)}
              onRequestDelete={handleContextMenuDelete}
              onCollapseFolderSubtree={handleCollapseFolderSubtree}
              onFindInFolder={handleFindInFolder}
              onMoveDrop={handleMoveDrop}
              onDragTargetChange={setDropTargetDir}
              onDragSourceChange={setDragSourcePath}
              onDragExpandDir={handleDragExpandDir}
              onNativeDragTargetChange={setNativeDropTargetDir}
              onNativeDragExpandDir={handleNativeDragExpandDir}
              dropTargetDir={dropTargetDir}
              dragSourcePath={dragSourcePath}
              nativeDropTargetDir={nativeDropTargetDir}
            />
          )}
        </ScrollArea>
      </div>

      <FileExplorerBackgroundMenu
        open={bgMenuOpen}
        onOpenChange={setBgMenuOpen}
        point={bgMenuPoint}
        worktreePath={worktreePath}
        onStartNew={startNew}
      />
    </>
  )
}

export default React.memo(FileExplorerInner)
