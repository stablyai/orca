import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { basename } from '@/lib/path'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getVisibleFileExplorerWorktreePath } from './file-explorer-reset'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerFilesTreePane } from './FileExplorerFilesTreePane'
import { FileExplorerNameFilter } from './FileExplorerNameFilter'
import { FileExplorerQueryStrip } from './FileExplorerQueryStrip'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import { SearchFilters } from './SearchFilters'
import { SearchQueryRow } from './SearchQueryRow'
import { SearchResultsPane } from './SearchResultsPane'
import { useFileSearchPanel } from './useFileSearchPanel'
import {
  getNameFilterCollapsedPathsAfterExpand,
  getNextNameFilterCollapsedPaths
} from './file-explorer-name-filter-projection'
import { useFileExplorerManualRefresh } from './useFileExplorerManualRefresh'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerSelection } from './useFileExplorerSelection'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import { useFileExplorerBackgroundMenu } from './use-file-explorer-background-menu'
import { useFileExplorerNameFilter } from './use-file-explorer-name-filter'
import { useFileExplorerTreePaneState } from './use-file-explorer-tree-pane-state'
import { translate } from '@/i18n/i18n'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

function FileExplorerFiles(): React.JSX.Element {
  const explorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const showRightSidebarFiles = useAppStore((s) => s.showRightSidebarFiles)
  const showRightSidebarSearch = useAppStore((s) => s.showRightSidebarSearch)
  const searchPanel = useFileSearchPanel(explorerView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const expandedDirs = useAppStore((s) => s.expandedDirs)
  const collapseAllDirs = useAppStore((s) => s.collapseAllDirs)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const openFiles = useAppStore((s) => s.openFiles)
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

  const tree = useFileExplorerTree(worktreePath, expanded, activeWorktreeId)
  const {
    nameFilterQuery,
    setNameFilterQuery,
    nameFilterCollapsedPaths,
    setNameFilterCollapsedPaths,
    hasNameFilter,
    nameFilterFiles,
    nameFilterSource,
    handleClearNameFilter
  } = useFileExplorerNameFilter({ isFilesViewActive, activeWorktreeId })

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
  const {
    rowProjection,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    nameFilterExpandedPaths,
    toggleGitIgnoredFiles
  } = useFileExplorerVisibleRowProjection(
    activeWorktreeId,
    visibleFilesWorktreePath,
    tree.dirCache,
    expanded,
    activeRepoSupportsGit && isFilesViewActive,
    showDotfiles,
    nameFilterSource,
    hasNameFilter ? nameFilterCollapsedPaths : null
  )
  const rowExpandedPaths = useMemo(
    () =>
      hasNameFilter
        ? nameFilterExpandedPaths
        : nameFilterExpandedPaths.size > 0
          ? new Set([...expanded, ...nameFilterExpandedPaths])
          : expanded,
    [expanded, hasNameFilter, nameFilterExpandedPaths]
  )
  const visibleRowCount = rowProjection.getVisibleCount()
  const manualRefresh = useFileExplorerManualRefresh(tree.refreshTree)
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
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const selection = useFileExplorerSelection(rowProjection, isMac)
  const selectedNode = selection.selectedPath
    ? rowProjection.getRowByPath(selection.selectedPath)
    : null
  const handleToggleNameFilterDir = useCallback(
    (_worktreeId: string, dirPath: string) => {
      setNameFilterCollapsedPaths((current) =>
        getNextNameFilterCollapsedPaths(current, dirPath, rowExpandedPaths.has(dirPath))
      )
    },
    [rowExpandedPaths, setNameFilterCollapsedPaths]
  )
  const handleExpandNameFilterDir = useCallback(
    (dirPath: string) => {
      setNameFilterCollapsedPaths((current) =>
        getNameFilterCollapsedPathsAfterExpand(current, dirPath)
      )
    },
    [setNameFilterCollapsedPaths]
  )
  // Why: every explorer effect lives here, above the `!worktreePath` early
  // return, so a transient null worktree cannot unmount the tree's reset guard
  // and SSH generation refs and trigger a full cache-dropping reload on return.
  const paneState = useFileExplorerTreePaneState({
    activeWorktreeId,
    activeRepo,
    worktreePath,
    visibleFilesWorktreePath,
    expanded,
    activeFileId,
    openFiles,
    hasNameFilter,
    setNameFilterQuery,
    handleToggleNameFilterDir,
    tree,
    selection,
    selectedNode,
    rowProjection,
    rowExpandedPaths,
    visibleRowCount
  })
  const { inlineInputState, rowScrolling } = paneState
  const {
    bgMenuOpen,
    setBgMenuOpen,
    bgMenuPoint,
    handleExplorerBackgroundContextMenuCapture,
    handleExplorerBackgroundDoubleClick
  } = useFileExplorerBackgroundMenu({
    worktreePath,
    inlineInput: inlineInputState.inlineInput,
    startNew: inlineInputState.startNew
  })

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

  return (
    <>
      <div
        ref={rowScrolling.setExplorerShellRef}
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
          <FileExplorerFilesTreePane
            activeRepo={activeRepo}
            worktreePath={worktreePath}
            visibleFilesWorktreePath={visibleFilesWorktreePath}
            explorerView={explorerView}
            isFilesViewActive={isFilesViewActive}
            activeFileId={activeFileId}
            hasNameFilter={hasNameFilter}
            nameFilterSource={nameFilterSource}
            nameFilterFiles={nameFilterFiles}
            handleExpandNameFilterDir={handleExpandNameFilterDir}
            tree={tree}
            selection={selection}
            paneState={paneState}
            rowProjection={rowProjection}
            ignoredByRelativePath={ignoredByRelativePath}
            rowExpandedPaths={rowExpandedPaths}
            visibleRowCount={visibleRowCount}
            handleExplorerBackgroundContextMenuCapture={handleExplorerBackgroundContextMenuCapture}
            handleExplorerBackgroundDoubleClick={handleExplorerBackgroundDoubleClick}
          />
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
        onStartNew={inlineInputState.startNew}
      />
    </>
  )
}

const FileExplorerFilesMemo = React.memo(FileExplorerFiles)

function FileExplorer(): React.JSX.Element {
  return <FileExplorerFilesMemo />
}

export default React.memo(FileExplorer)
