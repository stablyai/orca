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
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { getFileExplorerOperationExecutionHostId } from './file-explorer-operation-owner'
import type { WorkspaceFileDragSource } from '@/lib/workspace-file-drag'
import {
  isFileExplorerNodeReadOnly,
  isFileExplorerPathReadOnly
} from './file-explorer-row-action-visibility'

type FileExplorerVirtualRowsProps = {
  virtualizer: Virtualizer<HTMLDivElement, Element>
  inlineInputIndex: number
  rowProjection: FileExplorerRowProjection
  displayDepthOffset?: number
  readOnly?: boolean
  worktreePath?: string | null
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
  /** Cached ownership for selected paths hidden by collapse or filtering. */
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

/** Hidden selections still drag; fall back to cached host ownership when the projection omits them. */
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

/** Mixed-host drags have no single source owner; leave it null so the drop target fails closed. */
function resolveDragSourceOwner(
  rowProjection: FileExplorerRowProjection,
  dirCache: Record<string, DirCache> | undefined,
  paths: readonly string[]
): Omit<WorkspaceFileDragSource, 'workspaceId'> | null {
  let sourceOwner: Omit<WorkspaceFileDragSource, 'workspaceId'> | null = null
  for (const path of paths) {
    const owner = getDraggedPathOperationOwner(rowProjection, dirCache, path)
    const executionHostId = getFileExplorerOperationExecutionHostId(owner)
    const runtimeEnvironmentId = owner?.kind === 'runtime' ? owner.environmentId : undefined
    if (
      !executionHostId ||
      (sourceOwner &&
        (executionHostId !== sourceOwner.executionHostId ||
          runtimeEnvironmentId !== sourceOwner.runtimeEnvironmentId))
    ) {
      return null
    }
    sourceOwner = { executionHostId, ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {}) }
  }
  return sourceOwner
}

export function FileExplorerVirtualRows(props: FileExplorerVirtualRowsProps): React.JSX.Element {
  const {
    virtualizer,
    inlineInputIndex,
    rowProjection,
    displayDepthOffset = 0,
    readOnly = false,
    worktreePath = null,
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
  // Resolve only at dragstart; row virtualization renders on every scroll frame.
  const resolveSourceOwner = (paths: readonly string[]) =>
    resolveDragSourceOwner(rowProjection, dirCache, paths)

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
                depth={inlineDepth - displayDepthOffset}
                inlineInput={inlineInput!}
                onSubmit={handleInlineSubmit}
                onCancel={dismissInlineInput}
              />
            </div>
          )
        }

        const n = node!
        const nodeReadOnly = isFileExplorerNodeReadOnly(n, worktreePath, readOnly)
        const dragDisabled =
          selectedPaths.has(n.path) &&
          selectedPaths.size > 1 &&
          [...selectedPaths].some((path) =>
            isFileExplorerPathReadOnly(path, worktreePath, readOnly)
          )
        // Paths are already normalized at construction; avoid two redundant regexes per row render.
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
              readOnly={nodeReadOnly}
              dragDisabled={dragDisabled}
              displayDepthOffset={displayDepthOffset}
              node={n}
              isExpanded={expanded.has(n.path)}
              isLoading={n.isDirectory && loadingDirPaths.has(n.path)}
              loadError={n.isDirectory ? (dirCache?.[n.path]?.error ?? null) : null}
              isSelected={selectedPaths.has(n.path) || activeFileId === n.path}
              selectedPaths={selectedPaths}
              isFlashing={flashingPath === n.path}
              nodeStatus={nodeStatus}
              statusColor={nodeStatus ? STATUS_COLORS[nodeStatus] : null}
              isIgnored={isIgnored}
              deleteShortcutLabel={deleteShortcutLabel}
              connectionId={connectionId}
              sourceWorkspaceId={sourceWorkspaceId}
              resolveDragSourceOwner={resolveSourceOwner}
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
