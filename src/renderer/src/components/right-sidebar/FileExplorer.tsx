/* eslint-disable max-lines -- Why: FileExplorer coordinates tree data, selection, drag/drop, and virtual rows; splitting it during this merge would obscure the interaction invariants. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { basename, dirname } from '@/lib/path'
import { useRuntimeFileListForWorktree } from '@/components/quick-open-file-list'
import { folderRelativePathToIncludeGlob } from './file-search-include-pattern'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  getVisibleFileExplorerWorktreePath,
  shouldResetFileExplorerForVisibleWorktree
} from './file-explorer-reset'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerNameFilter } from './FileExplorerNameFilter'
import { FileExplorerQueryStrip } from './FileExplorerQueryStrip'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import { SearchFilters } from './SearchFilters'
import { SearchQueryRow } from './SearchQueryRow'
import { SearchResultsPane } from './SearchResultsPane'
import { useFileSearchPanel } from './useFileSearchPanel'
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
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import { translate } from '@/i18n/i18n'
import type { RightSidebarExplorerView } from '../../../../shared/types'

function FileExplorerFiles(): React.JSX.Element {
  const explorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const showRightSidebarFiles = useAppStore((s) => s.showRightSidebarFiles)
  const showRightSidebarSearch = useAppStore((s) => s.showRightSidebarSearch)
  const [nameFilterQuery, setNameFilterQuery] = useState('')
  const searchPanel = useFileSearchPanel(explorerView)

  const handleSelectExplorerView = useCallback(
    (view: RightSidebarExplorerView) => {
      if (view === 'files') {
        showRightSidebarFiles()
        return
      }
      const trimmedQuery = nameFilterQuery.trim()
      showRightSidebarSearch(trimmedQuery ? { query: trimmedQuery } : undefined)
    },
    [nameFilterQuery, showRightSidebarFiles, showRightSidebarSearch]
  )
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
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const openModal = useAppStore((s) => s.openModal)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const showDotfiles = useAppStore((s) =>
    activeWorktreeId ? (s.showDotfilesByWorktree[activeWorktreeId] ?? true) : true
  )
  const toggleShowDotfilesForWorktree = useAppStore((s) => s.toggleShowDotfilesForWorktree)

  const worktreePath = activeWorktree?.path ?? null
  const isFilesViewActive = explorerView === 'files'
  const visibleFilesWorktreePath = getVisibleFileExplorerWorktreePath({
    explorerView,
    rightSidebarOpen,
    worktreePath
  })
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
    rootCache,
    rootError,
    loadDir,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    resetAndLoad
  } = useFileExplorerTree(worktreePath, expanded, activeWorktreeId)
  const hasNameFilterQuery = nameFilterQuery.trim().length > 0
  const hasNameFilter = isFilesViewActive && hasNameFilterQuery
  const nameFilterFiles = useRuntimeFileListForWorktree({
    enabled: hasNameFilter,
    worktreeId: activeWorktreeId
  })
  const nameFilterSource = useMemo(
    () =>
      hasNameFilter
        ? {
            query: nameFilterQuery,
            relativePaths:
              nameFilterFiles.loading && nameFilterFiles.files.length === 0
                ? null
                : nameFilterFiles.files
          }
        : null,
    [hasNameFilter, nameFilterFiles.files, nameFilterFiles.loading, nameFilterQuery]
  )
  const {
    rowProjection,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    nameFilterExpandedPaths,
    toggleGitIgnoredFiles
  } = useFileExplorerVisibleRowProjection(
    activeWorktreeId,
    visibleFilesWorktreePath,
    dirCache,
    expanded,
    activeRepoSupportsGit && isFilesViewActive,
    showDotfiles,
    nameFilterSource
  )
  const rowExpandedPaths = useMemo(
    () =>
      nameFilterExpandedPaths.size > 0
        ? new Set([...expanded, ...nameFilterExpandedPaths])
        : expanded,
    [expanded, nameFilterExpandedPaths]
  )
  const visibleRowCount = rowProjection.getVisibleCount()
  const manualRefresh = useFileExplorerManualRefresh(refreshTree)
  const canCollapseAll = isFilesViewActive && !hasNameFilter && expanded.size > 0
  const handleCollapseAll = useCallback(() => {
    if (!activeWorktreeId || !isFilesViewActive || hasNameFilter) {
      return
    }
    collapseAllDirs(activeWorktreeId)
  }, [activeWorktreeId, collapseAllDirs, hasNameFilter, isFilesViewActive])
  const handleToggleDotfiles = useCallback(() => {
    if (activeWorktreeId) {
      toggleShowDotfilesForWorktree(activeWorktreeId)
    }
  }, [activeWorktreeId, toggleShowDotfilesForWorktree])
  const handleClearNameFilter = useCallback(() => {
    setNameFilterQuery('')
  }, [setNameFilterQuery])

  const [flashingPath, setFlashingPath] = useState<string | null>(null)
  const [bgMenuOpen, setBgMenuOpen] = useState(false)
  const [bgMenuPoint, setBgMenuPoint] = useState({ x: 0, y: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Includes Radix scroll viewport + scrollbar (scrollbar is not a child of the viewport). */
  const explorerShellRef = useRef<HTMLDivElement | null>(null)
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
    moveSelection,
    preserveSelectionForContextMenu,
    copyPathsForNode
  } = useFileExplorerSelection(rowProjection, isMac)

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
    if (!visibleFilesWorktreePath) {
      return
    }
    // Why: the sidebar remains mounted while closed to preserve caches, but
    // loading the hidden tree would probe every clicked workspace on macOS.
    if (
      !shouldResetFileExplorerForVisibleWorktree(
        lastResetWorktreePathRef.current,
        visibleFilesWorktreePath
      )
    ) {
      return
    }
    lastResetWorktreePathRef.current = visibleFilesWorktreePath
    resetSelection()
    setNameFilterQuery('')
    resetAndLoad()
    clearFileExplorerUndoHistory()
  }, [visibleFilesWorktreePath, resetSelection]) // eslint-disable-line react-hooks/exhaustive-deps

  // Why: on app startup the file explorer loads before SSH providers are
  // registered, so readDir fails for remote worktrees. When the SSH
  // connection is later established, sshConnectedGeneration bumps and this
  // effect retries the load. Only retries when there was a prior error to
  // avoid redundant reloads for local worktrees.
  const sshGenRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration > sshGenRef.current) {
      sshGenRef.current = sshConnectedGeneration
      if (visibleFilesWorktreePath && rootError) {
        resetAndLoad()
      }
    }
  }, [sshConnectedGeneration, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    for (const dirPath of expanded) {
      if (!dirCache[dirPath]?.children.length && !dirCache[dirPath]?.loading) {
        const depth =
          splitPathSegments(dirPath.slice(visibleFilesWorktreePath.length + 1)).length - 1
        void loadDir(dirPath, depth)
      }
    }
  }, [expanded, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    inlineInput,
    inlineInputIndex,
    startNew,
    startRename,
    dismissInlineInput,
    handleInlineSubmit
  } = useFileExplorerInlineInput({
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    expanded,
    rowProjection,
    scrollRef,
    refreshDir
  })

  useFileExplorerWatch({
    worktreePath: visibleFilesWorktreePath,
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
    worktreePath: visibleFilesWorktreePath,
    activeWorktreeId,
    refreshDir,
    clearNativeDragState,
    setSelectedPath: setSingleSelectedPath
  })

  const totalCount = visibleRowCount + (inlineInputIndex >= 0 ? 1 : 0)

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
        return rowProjection.getRowAtIndex(rowIndex)?.path ?? `__fallback_${index}`
      }
      return rowProjection.getRowAtIndex(index)?.path ?? `__fallback_${index}`
    }
  })

  const cancelRevealTimers = useFileExplorerReveal({
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    pendingExplorerReveal,
    clearPendingExplorerReveal,
    expanded,
    dirCache,
    rootCache,
    rowProjection,
    loadDir,
    setSelectedPath: setSingleSelectedPath,
    setFlashingPath,
    flashTimeoutRef,
    virtualizer
  })
  const setExplorerShellRef = useCallback(
    (node: HTMLDivElement | null): void => {
      explorerShellRef.current = node
      if (node !== null) {
        return
      }
      // Why: reveal flash/scroll timers target the explorer shell; clear them
      // when that owner detaches instead of keeping a passive unmount Effect.
      cancelRevealTimers()
    },
    [cancelRevealTimers]
  )

  useFileExplorerAutoReveal({
    activeFileId,
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    pendingExplorerReveal,
    openFiles,
    rowProjection,
    setSelectedPath: setSingleSelectedPath,
    virtualizer
  })

  useEffect(() => {
    if (inlineInputIndex >= 0) {
      virtualizer.scrollToIndex(inlineInputIndex, { align: 'auto' })
    }
  }, [inlineInputIndex, virtualizer])

  const selectedNode = selectedPath ? rowProjection.getRowByPath(selectedPath) : null
  const selectedNodes = useMemo(
    () => rowProjection.getRowsByPaths(selectedPaths),
    [rowProjection, selectedPaths]
  )
  const { handleClick, handleDoubleClick, handleWheelCapture } = useFileExplorerHandlers({
    activeWorktreeId,
    openFile,
    makePreviewFilePermanent,
    toggleDir,
    canToggleDirectories: !hasNameFilter,
    loadDir,
    statPath,
    markPathAsDirectory,
    setSelectedPath: setSingleSelectedPath,
    scrollRef
  })

  // Why: pass a stable activator so arrow-key navigation can hand the same
  // activate-toggles-folder / open-file-preview behavior the click handler
  // already uses, without the keyboard path re-implementing symlink handling.
  const activateNode = useCallback(
    (node: TreeNode) => {
      void handleClick(node)
    },
    [handleClick]
  )
  const scrollToIndex = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    },
    [virtualizer]
  )

  useFileExplorerKeys({
    containerRef: explorerShellRef,
    rowProjection,
    expandedPaths: rowExpandedPaths,
    canToggleDirectories: !hasNameFilter,
    inlineInput,
    selectedPaths,
    selectedNode,
    activateNode,
    moveSelection,
    toggleDir,
    startRename,
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
    (node: TreeNode, event: React.MouseEvent<HTMLButtonElement>) =>
      selectRowWithModifiers(node, event, handleClick),
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

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        {explorerView === 'search'
          ? translate(
              'auto.components.right.sidebar.Search.98c8435e36',
              'Select a workspace to search'
            )
          : translate(
              'auto.components.right.sidebar.FileExplorer.79b1537dd3',
              'Select a workspace to browse files'
            )}
      </div>
    )
  }

  // Why: the root explorer container must stay mounted for loading, error,
  // and empty states so the data-native-file-drop-target marker is always
  // present. Without this, external file drops would have no target surface
  // when the tree is empty, still loading, or showing a read error.
  const isEmptyState = visibleRowCount === 0 && !inlineInput
  const isNameFilterLoading = nameFilterSource?.relativePaths === null
  const isLoading =
    isEmptyState && (hasNameFilter ? isNameFilterLoading : (rootCache?.loading ?? true))
  const treeError = hasNameFilter ? nameFilterFiles.loadError : rootError
  const hasError = isEmptyState && !isLoading && !!treeError
  const showTree = !isEmptyState
  const emptyMessage =
    hasNameFilter && !nameFilterFiles.loadError
      ? translate(
          'auto.components.right.sidebar.FileExplorer.2f4483d6c4',
          'No files match this filter'
        )
      : undefined

  return (
    <>
      <div
        ref={setExplorerShellRef}
        data-orca-explorer-shell
        data-selected-folder-relative-path={
          selectedNode?.isDirectory ? selectedNode.relativePath : undefined
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        <FileExplorerToolbar
          repoName={repoName}
          worktreePath={worktreePath}
          connectionId={activeRepo?.connectionId ?? null}
          refresh={manualRefresh}
          canRefresh={isFilesViewActive}
          canCollapseAll={canCollapseAll}
          onCollapseAll={handleCollapseAll}
          showGitIgnoredFilesToggle={activeRepoSupportsGit}
          showGitIgnoredFiles={showGitIgnoredFiles}
          onToggleGitIgnoredFiles={toggleGitIgnoredFiles}
          showDotfiles={showDotfiles}
          onToggleDotfiles={handleToggleDotfiles}
        />
        <FileExplorerQueryStrip view={explorerView} onSelectView={handleSelectExplorerView}>
          {/* Why: keep both query rows mounted and cross-fade so the Names/Contents
             switch does not remount or shift when changing modes. */}
          <div className="relative min-h-7">
            <div
              className={cn(
                explorerView !== 'files' && 'pointer-events-none invisible absolute inset-x-0 top-0'
              )}
            >
              <FileExplorerNameFilter
                query={nameFilterQuery}
                loading={nameFilterFiles.loading}
                onQueryChange={setNameFilterQuery}
                onClear={handleClearNameFilter}
              />
            </div>
            <div
              className={cn(
                explorerView !== 'search' &&
                  'pointer-events-none invisible absolute inset-x-0 top-0'
              )}
            >
              <SearchQueryRow {...searchPanel.queryRowProps} />
            </div>
          </div>
        </FileExplorerQueryStrip>
        <div
          className={cn(
            'border-b border-border px-2 pb-1.5',
            explorerView !== 'search' &&
              'pointer-events-none invisible h-0 overflow-hidden border-b-0 p-0'
          )}
        >
          <SearchFilters {...searchPanel.filtersProps} />
        </div>
        {/* Why: the Files and Contents views share one body slot; layering them
           avoids remounting heavy virtualized panes while preserving full height. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ScrollArea
            className={cn(
              'absolute inset-0 min-h-0',
              explorerView !== 'files' && 'pointer-events-none invisible',
              isRootDragOver &&
                explorerView === 'files' &&
                !(dragSourcePath && dirname(dragSourcePath) === worktreePath) &&
                'bg-border',
              isNativeDragOver && explorerView === 'files' && !nativeDropTargetDir && 'bg-border'
            )}
            viewportRef={scrollRef}
            viewportTabIndex={-1}
            viewportClassName="h-full min-h-0 py-2"
            data-native-file-drop-target={isFilesViewActive ? 'file-explorer' : undefined}
            data-native-file-drop-dir={visibleFilesWorktreePath ?? undefined}
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
                error={hasError ? treeError : null}
                isEmpty={isEmptyState && !isLoading && !hasError}
                emptyMessage={emptyMessage}
              />
            )}
            {showTree && (
              <FileExplorerVirtualRows
                virtualizer={virtualizer}
                inlineInputIndex={inlineInputIndex}
                rowProjection={rowProjection}
                inlineInput={inlineInput}
                handleInlineSubmit={handleInlineSubmit}
                dismissInlineInput={dismissInlineInput}
                folderStatusByRelativePath={folderStatusByRelativePath}
                statusByRelativePath={statusByRelativePath}
                ignoredByRelativePath={ignoredByRelativePath}
                expanded={rowExpandedPaths}
                canCollapseFolderSubtree={!hasNameFilter}
                dirCache={dirCache}
                selectedPaths={selectedPaths}
                activeFileId={activeFileId}
                flashingPath={flashingPath}
                deleteShortcutLabel={deleteShortcutLabel}
                connectionId={activeRepo?.connectionId ?? null}
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
          <div
            className={cn(
              'absolute inset-0 flex min-h-0 flex-col',
              explorerView !== 'search' && 'pointer-events-none invisible'
            )}
          >
            {searchPanel.activeWorktreeId ? (
              <SearchResultsPane {...searchPanel.resultsProps} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {translate(
                  'auto.components.right.sidebar.Search.98c8435e36',
                  'Select a workspace to search'
                )}
              </div>
            )}
          </div>
        </div>
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

const FileExplorerFilesMemo = React.memo(FileExplorerFiles)

function FileExplorer(): React.JSX.Element {
  return <FileExplorerFilesMemo />
}

export default React.memo(FileExplorer)
