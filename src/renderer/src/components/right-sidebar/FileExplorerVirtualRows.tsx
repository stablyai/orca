import React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { dirname, normalizeRelativePath } from '@/lib/path'
import { cn } from '@/lib/utils'
import type { GitFileStatus } from '../../../../shared/types'
import { FileExplorerRow, InlineInputRow, type InlineInput } from './FileExplorerRow'
import { STATUS_COLORS } from './status-display'
import type { DirCache, TreeNode } from './file-explorer-types'

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
  selectedPath: string | null
  activeFileId: string | null
  flashingPath: string | null
  deleteShortcutLabel: string
  onClick: (node: TreeNode) => void
  onDoubleClick: (node: TreeNode) => void
  onSelectPath: (path: string) => void
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
    selectedPath,
    activeFileId,
    flashingPath,
    deleteShortcutLabel,
    onClick,
    onDoubleClick,
    onSelectPath,
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
              isSelected={selectedPath === n.path || activeFileId === n.path}
              isFlashing={flashingPath === n.path}
              nodeStatus={nodeStatus}
              statusColor={nodeStatus ? STATUS_COLORS[nodeStatus] : null}
              deleteShortcutLabel={deleteShortcutLabel}
              targetDir={n.isDirectory ? n.path : dirname(n.path)}
              targetDepth={n.isDirectory ? n.depth + 1 : n.depth}
              onClick={() => onClick(n)}
              onDoubleClick={() => onDoubleClick(n)}
              onSelect={() => onSelectPath(n.path)}
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
