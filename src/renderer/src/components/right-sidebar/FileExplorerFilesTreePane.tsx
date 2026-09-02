import type React from 'react'
import { dirname } from '@/lib/path'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { RuntimeFileListState } from '@/components/quick-open-file-list'
import type { Repo } from '../../../../shared/repo-types'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'
import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { canShowAddAsProjectAction } from './file-explorer-add-project-action'
import type { FileExplorerNameFilterProjectionSource } from './file-explorer-name-filter-projection'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { useFileExplorerSelection } from './useFileExplorerSelection'
import type { useFileExplorerTree } from './useFileExplorerTree'
import type { useFileExplorerTreePaneState } from './use-file-explorer-tree-pane-state'

type FileExplorerFilesTreePaneProps = {
  activeRepo: Repo | null
  worktreePath: string | null
  visibleFilesWorktreePath: string | null
  explorerView: RightSidebarExplorerView
  isFilesViewActive: boolean
  activeFileId: string | null
  hasNameFilter: boolean
  nameFilterSource: FileExplorerNameFilterProjectionSource | null
  nameFilterFiles: RuntimeFileListState
  handleExpandNameFilterDir: (dirPath: string) => void
  tree: ReturnType<typeof useFileExplorerTree>
  selection: ReturnType<typeof useFileExplorerSelection>
  paneState: ReturnType<typeof useFileExplorerTreePaneState>
  rowProjection: FileExplorerRowProjection
  ignoredByRelativePath: Set<string>
  rowExpandedPaths: Set<string>
  visibleRowCount: number
  handleExplorerBackgroundContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  handleExplorerBackgroundDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void
}

/** Presentational tree pane: every effect it renders from lives in useFileExplorerTreePaneState. */
export function FileExplorerFilesTreePane({
  activeRepo,
  worktreePath,
  visibleFilesWorktreePath,
  explorerView,
  isFilesViewActive,
  activeFileId,
  hasNameFilter,
  nameFilterSource,
  nameFilterFiles,
  handleExpandNameFilterDir,
  tree,
  selection,
  paneState,
  rowProjection,
  ignoredByRelativePath,
  rowExpandedPaths,
  visibleRowCount,
  handleExplorerBackgroundContextMenuCapture,
  handleExplorerBackgroundDoubleClick
}: FileExplorerFilesTreePaneProps): React.JSX.Element {
  const { dirCache, rootCache, rootError } = tree
  const { selectedPaths, preserveSelectionForContextMenu, copyPathsForNode } = selection
  const {
    scrollRef,
    runtimeDownloadContext,
    supportsFolderDownload,
    canOpenWorkspaceFileBrowserForPath,
    statusByRelativePath,
    folderStatusByRelativePath,
    deletion,
    dragDrop,
    inlineInputState,
    rowScrolling,
    handlers,
    nodeCommands
  } = paneState
  const { inlineInput, inlineInputIndex, startNew, dismissInlineInput, handleInlineSubmit } =
    inlineInputState
  const { virtualizer, flashingPath } = rowScrolling
  const { handleClick, handleDoubleClick, handleWheelCapture } = handlers
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
    rootDragHandlers
  } = dragDrop
  const {
    handleStartRename,
    handleContextMenuDelete,
    handleDuplicate,
    handleRowClick,
    handleCollapseFolderSubtree,
    handleFindInFolder,
    handleAddFolderAsProject,
    handleOpenInTerminal
  } = nodeCommands

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
    <ScrollArea
      className={cn(
        // Why: Radix ScrollArea.Root hard-sets inline `position: relative`,
        // defeating `absolute`; size by height so the viewport can overflow.
        'h-full min-h-0',
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
      viewportProps={{
        onContextMenuCapture: handleExplorerBackgroundContextMenuCapture,
        onDoubleClick: handleExplorerBackgroundDoubleClick
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
          deleteShortcutLabel={deletion.deleteShortcutLabel}
          connectionId={activeRepo?.connectionId ?? null}
          runtimeDownloadContext={runtimeDownloadContext}
          supportsFolderDownload={supportsFolderDownload}
          canOpenInOrcaBrowser={canOpenWorkspaceFileBrowserForPath}
          onClick={handleRowClick}
          onDoubleClick={handleDoubleClick}
          onViewFile={handleClick}
          onContextMenuSelect={preserveSelectionForContextMenu}
          onCopyPaths={copyPathsForNode}
          onStartNew={startNew}
          onStartRename={handleStartRename}
          onDuplicate={handleDuplicate}
          onAddFolderAsProject={handleAddFolderAsProject}
          canAddFolderAsProject={(node) => canShowAddAsProjectAction(node, activeRepo)}
          onOpenInTerminal={handleOpenInTerminal}
          onRequestDelete={handleContextMenuDelete}
          onCollapseFolderSubtree={handleCollapseFolderSubtree}
          onFindInFolder={handleFindInFolder}
          onMoveDrop={handleMoveDrop}
          onDragTargetChange={setDropTargetDir}
          onDragSourceChange={setDragSourcePath}
          onDragExpandDir={hasNameFilter ? handleExpandNameFilterDir : handleDragExpandDir}
          onNativeDragTargetChange={setNativeDropTargetDir}
          onNativeDragExpandDir={
            hasNameFilter ? handleExpandNameFilterDir : handleNativeDragExpandDir
          }
          dropTargetDir={dropTargetDir}
          dragSourcePath={dragSourcePath}
          nativeDropTargetDir={nativeDropTargetDir}
        />
      )}
    </ScrollArea>
  )
}
