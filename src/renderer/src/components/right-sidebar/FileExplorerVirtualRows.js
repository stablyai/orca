import { jsx as _jsx } from "react/jsx-runtime";
import { dirname, normalizeRelativePath } from '@/lib/path';
import { cn } from '@/lib/utils';
import { FileExplorerRow, InlineInputRow } from './FileExplorerRow';
import { STATUS_COLORS } from './status-display';
export function FileExplorerVirtualRows(props) {
    const { virtualizer, inlineInputIndex, flatRows, inlineInput, handleInlineSubmit, dismissInlineInput, folderStatusByRelativePath, statusByRelativePath, expanded, dirCache, selectedPath, activeFileId, flashingPath, deleteShortcutLabel, onClick, onDoubleClick, onSelectPath, onStartNew, onStartRename, onDuplicate, onRequestDelete, onMoveDrop, onDragTargetChange, onDragSourceChange, onDragExpandDir, onNativeDragTargetChange, onNativeDragExpandDir, dropTargetDir, dragSourcePath, nativeDropTargetDir } = props;
    return (_jsx("div", { className: "relative w-full", style: { height: `${virtualizer.getTotalSize()}px` }, children: virtualizer.getVirtualItems().map((vItem) => {
            const isInlineRow = inlineInputIndex >= 0 && vItem.index === inlineInputIndex;
            const rowIndex = !isInlineRow && inlineInputIndex >= 0 && vItem.index > inlineInputIndex
                ? vItem.index - 1
                : vItem.index;
            const node = isInlineRow ? null : flatRows[rowIndex];
            if (!isInlineRow && !node) {
                return null;
            }
            const showInline = isInlineRow ||
                (inlineInput?.type === 'rename' && node && inlineInput.existingPath === node.path);
            const inlineDepth = isInlineRow ? inlineInput.depth : (node?.depth ?? 0);
            if (showInline) {
                return (_jsx("div", { "data-index": vItem.index, ref: virtualizer.measureElement, className: "absolute left-0 right-0", style: { transform: `translateY(${vItem.start}px)` }, children: _jsx(InlineInputRow, { depth: inlineDepth, inlineInput: inlineInput, onSubmit: handleInlineSubmit, onCancel: dismissInlineInput }) }, vItem.key));
            }
            const n = node;
            const normalizedRelativePath = normalizeRelativePath(n.relativePath);
            const nodeStatus = n.isDirectory
                ? (folderStatusByRelativePath.get(normalizedRelativePath) ?? null)
                : (statusByRelativePath.get(normalizedRelativePath) ?? null);
            const rowParentDir = n.isDirectory ? n.path : dirname(n.path);
            const sourceParentDir = dragSourcePath ? dirname(dragSourcePath) : null;
            const isInDropTarget = (dropTargetDir != null &&
                dropTargetDir === rowParentDir &&
                dropTargetDir !== sourceParentDir) ||
                (nativeDropTargetDir != null && nativeDropTargetDir === rowParentDir);
            return (_jsx("div", { "data-index": vItem.index, ref: virtualizer.measureElement, className: cn('absolute left-0 right-0', isInDropTarget && 'bg-border'), style: { transform: `translateY(${vItem.start}px)` }, children: _jsx(FileExplorerRow, { node: n, isExpanded: expanded.has(n.path), isLoading: n.isDirectory && Boolean(dirCache[n.path]?.loading), isSelected: selectedPath === n.path || activeFileId === n.path, isFlashing: flashingPath === n.path, nodeStatus: nodeStatus, statusColor: nodeStatus ? STATUS_COLORS[nodeStatus] : null, deleteShortcutLabel: deleteShortcutLabel, targetDir: n.isDirectory ? n.path : dirname(n.path), targetDepth: n.isDirectory ? n.depth + 1 : n.depth, onClick: () => onClick(n), onDoubleClick: () => onDoubleClick(n), onSelect: () => onSelectPath(n.path), onStartNew: onStartNew, onStartRename: onStartRename, onDuplicate: onDuplicate, onRequestDelete: () => onRequestDelete(n), onMoveDrop: onMoveDrop, onDragTargetChange: onDragTargetChange, onDragSourceChange: onDragSourceChange, onDragExpandDir: onDragExpandDir, onNativeDragTargetChange: onNativeDragTargetChange, onNativeDragExpandDir: onNativeDragExpandDir }) }, vItem.key));
        }) }));
}
