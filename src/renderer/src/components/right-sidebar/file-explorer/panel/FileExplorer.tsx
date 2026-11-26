import React, { useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { getWorkspaceFileRevealOwner } from '@/lib/files/os-open/reveal-in-file-manager'
import { getRouteForLocalPathOpenOwner } from '@/lib/files/os-open/local-path-open-guard'
import { useActiveWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import {
  getExplorerDisplayRootOptions,
  resolveExplorerDisplayRootChoice,
  getExplorerDisplayRootPath,
  getExplorerDisplayDepth,
  getExplorerEffectiveExpanded
} from '../navigation/file-explorer-display-root'
import { FileExplorerScopeNotice } from './FileExplorerScopeNotice'
import { useFileExplorerRootNavigation } from '../navigation/use-file-explorer-root-navigation'
import { useFileExplorerScopeTransition } from '../navigation/use-file-explorer-scope-transition'
import { basename } from '@/lib/path'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import { getVisibleFileExplorerWorktreePath } from '../navigation/file-explorer-reset'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerFilesTreePane } from '../tree/FileExplorerFilesTreePane'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import {
  FileExplorerSearchPane,
  type FileExplorerSearchControl
} from '../combined-search/FileExplorerSearchPane'
import { useNameMatchRowActions } from '../combined-search/use-name-match-row-actions'
import { useFileExplorerManualRefresh } from './useFileExplorerManualRefresh'
import { useFileExplorerTree } from '../tree/useFileExplorerTree'
import { getFileExplorerOperationOwnerFromState } from '../navigation/file-explorer-operation-owner'
import { useFileExplorerSelection } from '../selection/useFileExplorerSelection'
import { useFileExplorerVisibleRowProjection } from '../tree/useFileExplorerVisibleRowProjection'
import { useFileExplorerBackgroundMenu } from './use-file-explorer-background-menu'
import { useFileExplorerTreePaneState } from '../tree/use-file-explorer-tree-pane-state'
import { useWslHostUnavailableReason } from '../../../../runtime/hosts/wsl/wsl-host-availability'
import { useWslHostReadOutage } from '../../../wsl-host-stopped/use-stopped-wsl-host'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

/** Coordinates scoped navigation while retaining the actual worktree root for file operations and runtime routing. */
function FileExplorerFiles(): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const runtimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, activeWorktreeId)
  )
  const wslHostUnavailable = useWslHostUnavailableReason(activeWorktreeId)
  const stoppedWslHost = useWslHostReadOutage(activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  // Why: a folder workspace has no repo row, so only the catalog owner names its SSH host.
  const openInOwner = useAppStore((s) =>
    getWorkspaceFileRevealOwner(s, activeWorktreeId, {
      connectionId: activeRepo?.connectionId,
      runtimeEnvironmentId
    })
  )
  const activeExpandedDirs = useAppStore((s) =>
    activeWorktreeId ? s.expandedDirs[activeWorktreeId] : undefined
  )
  const collapseAllDirs = useAppStore((s) => s.collapseAllDirs)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const openFiles = useAppStore((s) => s.openFiles)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const showDotfiles = useAppStore((s) =>
    activeWorktreeId ? (s.showDotfilesByWorktree[activeWorktreeId] ?? true) : true
  )
  const toggleShowDotfilesForWorktree = useAppStore((s) => s.toggleShowDotfilesForWorktree)

  const savedRoot = useAppStore((s) =>
    activeWorktreeId ? s.explorerDisplayRootByWorktree[activeWorktreeId] : undefined
  )
  const rootOptions = useMemo(() => getExplorerDisplayRootOptions(activeWorktree), [activeWorktree])
  const rootChoice = resolveExplorerDisplayRootChoice(rootOptions, savedRoot)
  const rootNavigation = useFileExplorerRootNavigation(activeWorktreeId, rootChoice, rootOptions)
  const worktreePath = activeWorktree?.path ?? null
  const displayRootPath = getExplorerDisplayRootPath(worktreePath, rootChoice)
  const displayDepth = getExplorerDisplayDepth(worktreePath, displayRootPath)
  // Search results cover the tree; treat that like the old search view so hidden tree work pauses.
  const searchActive = useAppStore((s) =>
    activeWorktreeId ? s.fileSearchStateByWorktree[activeWorktreeId]?.active === true : false
  )
  const treeView = searchActive ? 'search' : 'files'
  const visibleFilesWorktreePath = getVisibleFileExplorerWorktreePath({
    explorerView: treeView,
    rightSidebarOpen,
    worktreePath
  })
  const repoName = activeRepo?.displayName ?? (worktreePath ? basename(worktreePath) : '')
  const activeRepoSupportsGit = activeRepo ? isGitRepoKind(activeRepo) : false

  const expanded = useMemo(() => activeExpandedDirs ?? new Set<string>(), [activeExpandedDirs])

  const effectiveExpanded = useMemo(
    () =>
      getExplorerEffectiveExpanded(
        expanded,
        visibleFilesWorktreePath && displayRootPath !== worktreePath ? displayRootPath : null
      ),
    [expanded, visibleFilesWorktreePath, displayRootPath, worktreePath]
  )
  const tree = useFileExplorerTree(worktreePath, effectiveExpanded, activeWorktreeId)
  const searchControlRef = useRef<FileExplorerSearchControl>(null)
  const clearSearch = useCallback(() => searchControlRef.current?.clear(), [])
  const hasNameFilter = searchActive

  const { rowProjection, ignoredByRelativePath, showGitIgnoredFiles, toggleGitIgnoredFiles } =
    useFileExplorerVisibleRowProjection(
      activeWorktreeId,
      visibleFilesWorktreePath,
      tree.dirCache,
      expanded,
      activeRepoSupportsGit,
      showDotfiles,
      visibleFilesWorktreePath ? displayRootPath : null
    )
  const rowExpandedPaths = expanded
  const visibleRowCount = rowProjection.getVisibleCount()
  const manualRefresh = useFileExplorerManualRefresh(tree.refreshTree)
  const canCollapseAll = !hasNameFilter && expanded.size > 0
  const handleCollapseAll = useCallback(() => {
    if (!activeWorktreeId || hasNameFilter) {
      return
    }
    collapseAllDirs(activeWorktreeId)
  }, [activeWorktreeId, collapseAllDirs, hasNameFilter])
  const handleToggleDotfiles = useCallback(() => {
    if (activeWorktreeId) {
      toggleShowDotfilesForWorktree(activeWorktreeId)
    }
  }, [activeWorktreeId, toggleShowDotfilesForWorktree])
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const selection = useFileExplorerSelection(rowProjection, isMac, openInOwner)
  const selectedNode = selection.selectedPath
    ? rowProjection.getRowByPath(selection.selectedPath)
    : null
  // Keep effects above the null-path return so transient missing ownership cannot reset cache guards or SSH generations.
  const paneState = useFileExplorerTreePaneState({
    onRevealOutsideRoot: rootNavigation.revealOutsideRoot,
    activeWorktreeId,
    activeRepo,
    worktreePath,
    visibleFilesWorktreePath,
    displayRootPath,
    effectiveExpanded,
    expanded,
    activeFileId,
    openFiles,
    hasNameFilterQuery: searchActive,
    clearNameFilter: clearSearch,
    tree,
    selection,
    selectedNode,
    rowProjection,
    rowExpandedPaths,
    visibleRowCount,
    pathOwner: openInOwner
  })
  const { inlineInputState, rowScrolling } = paneState
  const {
    bgMenuOpen,
    setBgMenuOpen,
    bgMenuPoint,
    handleExplorerBackgroundContextMenuCapture,
    handleExplorerBackgroundDoubleClick
  } = useFileExplorerBackgroundMenu({
    worktreePath: displayRootPath,
    displayDepth,
    inlineInput: inlineInputState.inlineInput,
    startNew: inlineInputState.startNew
  })

  useFileExplorerScopeTransition({
    displayRootPath,
    activeWorktreeId,
    paneState,
    selection,
    setBgMenuOpen
  })

  const nameRowActions = useNameMatchRowActions({
    activeWorktreeId,
    searchActive,
    clearSearch,
    rowProjection,
    pathOwner: openInOwner,
    displayRootPath,
    connectionId: activeRepo?.connectionId ?? null,
    runtimeDownloadContext: paneState.runtimeDownloadContext,
    deleteShortcutLabel: paneState.deletion.deleteShortcutLabel,
    canOpenInOrcaBrowser: paneState.canOpenWorkspaceFileBrowserForPath,
    openNode: paneState.handlers.handleClick,
    pinNode: paneState.handlers.handleDoubleClick,
    startNewInTree: inlineInputState.startNew,
    startRenameInTree: inlineInputState.startRename,
    duplicate: paneState.nodeCommands.handleDuplicate,
    requestDelete: paneState.deletion.requestDelete
  })

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        {t(
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
          {...getRouteForLocalPathOpenOwner(openInOwner)}
          workspaceId={activeWorktreeId}
          refresh={manualRefresh}
          canRefresh={!searchActive}
          canCollapseAll={canCollapseAll}
          onCollapseAll={handleCollapseAll}
          showGitIgnoredFilesToggle={activeRepoSupportsGit}
          showGitIgnoredFiles={showGitIgnoredFiles}
          onToggleGitIgnoredFiles={toggleGitIgnoredFiles}
          showDotfiles={showDotfiles}
          onToggleDotfiles={handleToggleDotfiles}
        />
        {activeWorktree?.isSparse && (
          <FileExplorerScopeNotice
            rootSelect={
              rootOptions
                ? {
                    options: rootOptions,
                    value: rootChoice,
                    onValueChange: rootNavigation.selectRoot,
                    disabled:
                      Boolean(paneState.dragDrop.dragSourcePath) ||
                      paneState.dragDrop.isNativeDragOver
                  }
                : null
            }
            returnRoot={rootNavigation.returnRoot}
            onSelectRoot={rootNavigation.selectRoot}
            disabled={
              Boolean(paneState.dragDrop.dragSourcePath) || paneState.dragDrop.isNativeDragOver
            }
            sparse={!!activeWorktree?.isSparse}
          />
        )}
        <FileExplorerSearchPane
          // Local worktrees share one owner key, so the draft is owned per worktree here.
          key={activeWorktreeId ?? ''}
          controlRef={searchControlRef}
          activeWorktreeId={activeWorktreeId}
          worktreePath={worktreePath}
          displayRootPath={displayRootPath}
          showDotfiles={showDotfiles}
          showGitIgnoredFiles={showGitIgnoredFiles}
          activeRepoSupportsGit={activeRepoSupportsGit}
          scopeLabel={rootOptions?.find((option) => option.value === rootChoice)?.label}
          rowActions={nameRowActions}
          tree={
            // Kept mounted under results so clearing the query restores its scroll and caches.
            <FileExplorerFilesTreePane
              displayRootPath={displayRootPath}
              activeRepo={activeRepo}
              worktreePath={worktreePath}
              explorerView={treeView}
              activeFileId={activeFileId}
              tree={tree}
              selection={selection}
              paneState={paneState}
              rowProjection={rowProjection}
              ignoredByRelativePath={ignoredByRelativePath}
              rowExpandedPaths={rowExpandedPaths}
              visibleRowCount={visibleRowCount}
              handleExplorerBackgroundContextMenuCapture={
                handleExplorerBackgroundContextMenuCapture
              }
              handleExplorerBackgroundDoubleClick={handleExplorerBackgroundDoubleClick}
              wslHostUnavailable={wslHostUnavailable}
              stoppedWslHost={stoppedWslHost}
            />
          }
        />
      </div>

      <FileExplorerBackgroundMenu
        open={bgMenuOpen}
        onOpenChange={setBgMenuOpen}
        point={bgMenuPoint}
        worktreePath={displayRootPath ?? worktreePath}
        displayDepth={displayDepth}
        onStartNew={inlineInputState.startNew}
      />
    </>
  )
}

const FileExplorerFilesMemo = React.memo(FileExplorerFiles)

function FileExplorer(): React.JSX.Element {
  const ownerKey = useAppStore((state) =>
    JSON.stringify(getFileExplorerOperationOwnerFromState(state, state.activeWorktreeId))
  )
  // Different hosts can expose the same path; their explorer caches must have separate lifetimes.
  return <FileExplorerFilesMemo key={ownerKey} />
}

export default React.memo(FileExplorer)
