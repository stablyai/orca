import React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { dirname, normalizeRelativePath } from '@/lib/path'
import { cn } from '@/lib/utils'
import type { GitFileStatus } from '../../../../shared/types'
import { FileExplorerRow, InlineInputRow, type InlineInput } from './FileExplorerRow'
import { STATUS_COLORS } from './status-display'
import type { DirCache, TreeNode } from './file-explorer-types'
import { countVisibleFileExplorerSelections } from './file-explorer-selection'

type FileExplorerVirtualRowsProps = {
  virtualizer: Virtualizer<HTMLDivElement, Element>
  inlineInputIndex: number
  flatRows: TreeNode[]
  inlineInput: InlineInput | null
  handleInlineSubmit: (value: string) => void
  dismissInlineInput: () => void
  folderStatusByRelativePath: Map<string, GitFileStatus | null>
  statusByRelativePath: Map<string, GitFileStatus>
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  selectedPaths: Set<string>
  activeFileId: string | null
  flashingPath: string | null
  deleteShortcutLabel: string
  onClick: (node: TreeNode, event: React.MouseEvent<HTMLButtonElement>) => void
  onDoubleClick: (node: TreeNode) => void
  onContextMenuSelect: (node: TreeNode) => void
  onCopyPaths: (node: TreeNode, pathKind: 'absolute' | 'relative') => void
  onStartNew: (type: 'file' | 'folder', parentPath: string, depth: number) => void
  onStartRename: (node: TreeNode) => void
  onDuplicate: (node: TreeNode) => void
  onRequestDelete: (node: TreeNode) => void
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

export function FileExplorerVirtualRows(props: FileExplorerVirtualRowsProps): React.JSX.Element {
  const {
    virtualizer,
    inlineInputIndex,
    flatRows,
    inlineInput,
    handleInlineSubmit,
    dismissInlineInput,
    folderStatusByRelativePath,
    statusByRelativePath,
    expanded,
    dirCache,
    selectedPaths,
    activeFileId,
    flashingPath,
    deleteShortcutLabel,
    onClick,
    onDoubleClick,
    onContextMenuSelect,
    onCopyPaths,
    onStartNew,
    onStartRename,
    onDuplicate,
    onRequestDelete,
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

  const visibleSelectionCount = countVisibleFileExplorerSelections(flatRows, selectedPaths)

  return (
    <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((vItem) => {
        const isInlineRow = inlineInputIndex >= 0 && vItem.index === inlineInputIndex
        const rowIndex =
          !isInlineRow && inlineInputIndex >= 0 && vItem.index > inlineInputIndex
            ? vItem.index - 1
            : vItem.index
        const node = isInlineRow ? null : flatRows[rowIndex]
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
        const normalizedRelativePath = normalizeRelativePath(n.relativePath)
        const nodeStatus = n.isDirectory
          ? (folderStatusByRelativePath.get(normalizedRelativePath) ?? null)
          : (statusByRelativePath.get(normalizedRelativePath) ?? null)

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
              isLoading={n.isDirectory && Boolean(dirCache[n.path]?.loading)}
              isSelected={selectedPaths.has(n.path) || activeFileId === n.path}
              isFlashing={flashingPath === n.path}
              nodeStatus={nodeStatus}
              statusColor={nodeStatus ? STATUS_COLORS[nodeStatus] : null}
              deleteShortcutLabel={deleteShortcutLabel}
              targetDir={n.isDirectory ? n.path : dirname(n.path)}
              targetDepth={n.isDirectory ? n.depth + 1 : n.depth}
              selectionSize={selectedPaths.has(n.path) ? visibleSelectionCount : 1}
              onClick={(event) => onClick(n, event)}
              onDoubleClick={() => onDoubleClick(n)}
              onContextMenuSelect={() => onContextMenuSelect(n)}
              onCopyPaths={(pathKind) => onCopyPaths(n, pathKind)}
              onStartNew={onStartNew}
              onStartRename={onStartRename}
              onDuplicate={onDuplicate}
              onRequestDelete={() => onRequestDelete(n)}
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
