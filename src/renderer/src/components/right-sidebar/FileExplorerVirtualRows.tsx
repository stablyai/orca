import React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import { FileExplorerRow } from './FileExplorerRow'
import { InlineInputRow, type InlineInput } from './file-explorer-inline-input-row'
import { shouldShowIgnoredDecoration, STATUS_COLORS } from './status-display'
import type { DirCache, FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { getFileExplorerOperationExecutionHostId } from './file-explorer-operation-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type FileExplorerVirtualRowsProps = {
  virtualizer: Virtualizer<HTMLDivElement, Element>
  inlineInputIndex: number
  rowProjection: FileExplorerRowProjection
  inlineInput: InlineInput | null
  handleInlineSubmit: (value: string) => void
  dismissInlineInput: () => void
  folderStatusByRelativePath: Map<string, GitFileStatus | null>
  statusByRelativePath: Map<string, GitFileStatus>
  ignoredByRelativePath: Set<string>
  expanded: Set<string>
  canCollapseFolderSubtree?: boolean
  loadingDirPaths: ReadonlySet<string>
  selectedPaths: Set<string>
  activeFileId: string | null
  flashingPath: string | null
  deleteShortcutLabel: string
  connectionId?: string | null
  sourceWorkspaceId?: string | null
  /** Listings behind the projection, so a drag can name the owner of a selected
   *  path whose row is currently hidden. */
  dirCache?: Record<string, DirCache>
  runtimeDownloadContext?: RuntimeFileOperationArgs | null
  supportsFolderDownload?: boolean
  canOpenInOrcaBrowser?: (filePath: string) => boolean
  onClick: (node: TreeNode, event: React.MouseEvent<HTMLButtonElement>) => void
  onDoubleClick: (node: TreeNode) => void
  onViewFile: (node: TreeNode) => void
  onContextMenuSelect: (node: TreeNode) => void
  onCopyPaths: (node: TreeNode, pathKind: 'absolute' | 'relative') => void
  onStartNew: (type: 'file' | 'folder', parentPath: string, depth: number) => void
  onStartRename: (node: TreeNode) => void
  onDuplicate: (node: TreeNode) => void
  onAddFolderAsProject: (node: TreeNode) => void
  canAddFolderAsProject: (node: TreeNode) => boolean
  onOpenInTerminal: (node: TreeNode) => void
  onRequestDelete: (node: TreeNode) => void
  onCollapseFolderSubtree: (node: TreeNode) => void
  onFindInFolder: (node: TreeNode) => void
  onMoveDrop: (sourcePath: string, destDir: string) => void
  onDragTargetChange: (dir: string | null) => void
  onDragSourceChange: (path: string | null) => void
  onDragExpandDir: (dirPath: string) => void
  onNativeDragTargetChange: (dir: string | null) => void
  onNativeDragExpandDir: (dirPath: string) => void
  dropTargetDir: string | null
  dragSourcePath: string | null
  nativeDropTargetDir: string | null
}

/** The owner of a dragged path, from the visible row when there is one and from
 *  the cached listing when there is not. A selection survives collapsing a
 *  directory, a name filter and the dotfile toggle, and the drag still carries
 *  those paths — the projection only stopped indexing them, the cache still
 *  records which host listed them. */
function getDraggedPathOperationOwner(
  rowProjection: FileExplorerRowProjection,
  dirCache: Record<string, DirCache> | undefined,
  path: string
): FileExplorerOperationOwner | undefined {
  const visibleOwner = rowProjection.getRowByPath(path)?.operationOwner

  if (visibleOwner || !dirCache) {
    return visibleOwner
  }

  const parent = dirCache[dirname(path)]

  return parent?.children.find((child) => child.path === path)?.operationOwner
}

/** Null unless every dragged row came from one host: a mixed-owner drag has no
 *  single source to stamp, so it must fail closed at the drop target. */
function resolveDragSourceExecutionHostId(
  rowProjection: FileExplorerRowProjection,
  dirCache: Record<string, DirCache> | undefined,
  paths: readonly string[]
): ExecutionHostId | null {
  let sourceExecutionHostId: ExecutionHostId | null = null

  for (const path of paths) {
    const executionHostId = getFileExplorerOperationExecutionHostId(
      getDraggedPathOperationOwner(rowProjection, dirCache, path)
    )

    if (!executionHostId || (sourceExecutionHostId && executionHostId !== sourceExecutionHostId)) {
      return null
    }

    sourceExecutionHostId = executionHostId
  }

  return sourceExecutionHostId
}

export function FileExplorerVirtualRows(props: FileExplorerVirtualRowsProps): React.JSX.Element {
  const {
    virtualizer,
    inlineInputIndex,
    rowProjection,
    inlineInput,
    handleInlineSubmit,
    dismissInlineInput,
    folderStatusByRelativePath,
    statusByRelativePath,
    ignoredByRelativePath,
    expanded,
    canCollapseFolderSubtree = true,
    loadingDirPaths,
    selectedPaths,
    activeFileId,
    flashingPath,
    deleteShortcutLabel,
    connectionId,
    sourceWorkspaceId,
    dirCache,
    runtimeDownloadContext,
    supportsFolderDownload = false,
    canOpenInOrcaBrowser = () => false,
    onClick,
    onDoubleClick,
    onViewFile,
    onContextMenuSelect,
    onCopyPaths,
    onStartNew,
    onStartRename,
    onDuplicate,
    onAddFolderAsProject,
    canAddFolderAsProject,
    onOpenInTerminal,
    onRequestDelete,
    onCollapseFolderSubtree,
    onFindInFolder,
    onMoveDrop,
    onDragTargetChange,
    onDragSourceChange,
    onDragExpandDir,
    onNativeDragTargetChange,
    onNativeDragExpandDir,
    dropTargetDir,
    dragSourcePath,
    nativeDropTargetDir
  } = props

  const visibleSelectionCount = rowProjection.countVisiblePaths(selectedPaths)

  // Resolved at dragstart, not per render: the virtualizer re-renders on every
  // scroll frame and only a drag ever reads this.
  const resolveDragSourceHostId = (paths: readonly string[]): ExecutionHostId | null =>
    resolveDragSourceExecutionHostId(rowProjection, dirCache, paths)

  return (
    <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((vItem) => {
        const isInlineRow = inlineInputIndex >= 0 && vItem.index === inlineInputIndex

        const rowIndex =
          !isInlineRow && inlineInputIndex >= 0 && vItem.index > inlineInputIndex
            ? vItem.index - 1
            : vItem.index

        const node = isInlineRow ? null : rowProjection.getRowAtIndex(rowIndex)

        if (!isInlineRow && !node) {
          return null
        }

        const showInline =
          isInlineRow ||
          (inlineInput?.type === 'rename' && node && inlineInput.existingPath === node.path)

        const inlineDepth = isInlineRow ? inlineInput!.depth : (node?.depth ?? 0)

        if (showInline) {
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              <InlineInputRow
                depth={inlineDepth}
                inlineInput={inlineInput!}
                onSubmit={handleInlineSubmit}
                onCancel={dismissInlineInput}
              />
            </div>
          )
        }

        const n = node!
        // Why: relativePath is normalized at construction (fileExplorerEntriesToTreeNodes), so re-normalizing per row per render only paid 2 regexes for a byte-identical string.
        const normalizedRelativePath = n.relativePath

        const nodeStatus = n.isDirectory
          ? (folderStatusByRelativePath.get(normalizedRelativePath) ?? null)
          : (statusByRelativePath.get(normalizedRelativePath) ?? null)

        const isIgnored = shouldShowIgnoredDecoration(
          nodeStatus,
          ignoredByRelativePath,
          normalizedRelativePath
        )

        const rowParentDir = n.isDirectory ? n.path : dirname(n.path)
        const sourceParentDir = dragSourcePath ? dirname(dragSourcePath) : null

        const isInDropTarget =
          (dropTargetDir != null &&
            dropTargetDir === rowParentDir &&
            dropTargetDir !== sourceParentDir) ||
          (nativeDropTargetDir != null && nativeDropTargetDir === rowParentDir)

        return (
          <div
            key={vItem.key}
            data-index={vItem.index}
            ref={virtualizer.measureElement}
            className={cn('absolute left-0 right-0', isInDropTarget && 'bg-border')}
            style={{ transform: `translateY(${vItem.start}px)` }}
          >
            <FileExplorerRow
              node={n}
              isExpanded={expanded.has(n.path)}
              isLoading={n.isDirectory && loadingDirPaths.has(n.path)}
              isSelected={selectedPaths.has(n.path) || activeFileId === n.path}
              selectedPaths={selectedPaths}
              isFlashing={flashingPath === n.path}
              nodeStatus={nodeStatus}
              statusColor={nodeStatus ? STATUS_COLORS[nodeStatus] : null}
              isIgnored={isIgnored}
              deleteShortcutLabel={deleteShortcutLabel}
              connectionId={connectionId}
              sourceWorkspaceId={sourceWorkspaceId}
              resolveDragSourceHostId={resolveDragSourceHostId}
              runtimeDownloadContext={runtimeDownloadContext}
              supportsFolderDownload={supportsFolderDownload}
              canOpenInOrcaBrowser={canOpenInOrcaBrowser(n.path)}
              canCollapseFolderSubtree={canCollapseFolderSubtree}
              targetDir={n.isDirectory ? n.path : dirname(n.path)}
              targetDepth={n.isDirectory ? n.depth + 1 : n.depth}
              selectionSize={selectedPaths.has(n.path) ? visibleSelectionCount : 1}
              onClick={(event) => onClick(n, event)}
              onDoubleClick={() => onDoubleClick(n)}
              onViewFile={() => onViewFile(n)}
              onContextMenuSelect={() => onContextMenuSelect(n)}
              onCopyPaths={(pathKind) => onCopyPaths(n, pathKind)}
              onStartNew={onStartNew}
              onStartRename={onStartRename}
              onDuplicate={onDuplicate}
              onAddFolderAsProject={() => onAddFolderAsProject(n)}
              canAddAsProject={canAddFolderAsProject(n)}
              onOpenInTerminal={() => onOpenInTerminal(n)}
              onRequestDelete={() => onRequestDelete(n)}
              onCollapseFolderSubtree={() => onCollapseFolderSubtree(n)}
              onFindInFolder={() => onFindInFolder(n)}
              onMoveDrop={onMoveDrop}
              onDragTargetChange={onDragTargetChange}
              onDragSourceChange={onDragSourceChange}
              onDragExpandDir={onDragExpandDir}
              onNativeDragTargetChange={onNativeDragTargetChange}
              onNativeDragExpandDir={onNativeDragExpandDir}
            />
          </div>
        )
      })}
    </div>
  )
}
