import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/store';
import { dirname } from '@/lib/path';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { FileDeleteDialog } from './FileDeleteDialog';
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu';
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows';
import { splitPathSegments } from './path-tree';
import { buildFolderStatusMap, buildStatusMap } from './status-display';
import { useFileDeletion } from './useFileDeletion';
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal';
import { useFileExplorerHandlers } from './useFileExplorerHandlers';
import { useFileExplorerReveal } from './useFileExplorerReveal';
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput';
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo';
import { useFileExplorerKeys } from './useFileExplorerKeys';
import { useActiveWorktreePath } from './useActiveWorktreePath';
import { useFileDuplicate } from './useFileDuplicate';
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop';
import { useFileExplorerImport } from './useFileExplorerImport';
import { useFileExplorerTree } from './useFileExplorerTree';
import { useFileExplorerWatch } from './useFileExplorerWatch';
function FileExplorerInner() {
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const worktreesByRepo = useAppStore((s) => s.worktreesByRepo);
    const expandedDirs = useAppStore((s) => s.expandedDirs);
    const toggleDir = useAppStore((s) => s.toggleDir);
    const pendingExplorerReveal = useAppStore((s) => s.pendingExplorerReveal);
    const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal);
    const openFile = useAppStore((s) => s.openFile);
    const pinFile = useAppStore((s) => s.pinFile);
    const activeFileId = useAppStore((s) => s.activeFileId);
    const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree);
    const openFiles = useAppStore((s) => s.openFiles);
    const closeFile = useAppStore((s) => s.closeFile);
    const worktreePath = useActiveWorktreePath(activeWorktreeId, worktreesByRepo);
    const expanded = useMemo(() => activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set()) : new Set(), [activeWorktreeId, expandedDirs]);
    const { dirCache, setDirCache, flatRows, rowsByPath, rootCache, rootError, loadDir, refreshTree, refreshDir, resetAndLoad } = useFileExplorerTree(worktreePath, expanded, activeWorktreeId);
    const [selectedPath, setSelectedPath] = useState(null);
    const [flashingPath, setFlashingPath] = useState(null);
    const [bgMenuOpen, setBgMenuOpen] = useState(false);
    const [bgMenuPoint, setBgMenuPoint] = useState({ x: 0, y: 0 });
    const scrollRef = useRef(null);
    /** Includes Radix scroll viewport + scrollbar (scrollbar is not a child of the viewport). */
    const explorerShellRef = useRef(null);
    const flashTimeoutRef = useRef(null);
    const isMac = useMemo(() => navigator.userAgent.includes('Mac'), []);
    const isWindows = useMemo(() => navigator.userAgent.includes('Windows'), []);
    const clearFlashTimeout = useCallback(() => {
        if (flashTimeoutRef.current !== null) {
            window.clearTimeout(flashTimeoutRef.current);
            flashTimeoutRef.current = null;
        }
    }, []);
    const entries = useMemo(() => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []), [activeWorktreeId, gitStatusByWorktree]);
    const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries]);
    const folderStatusByRelativePath = useMemo(() => buildFolderStatusMap(entries), [entries]);
    const { pendingDelete, isDeleting, deleteShortcutLabel, deleteActionLabel, deleteDescription, requestDelete, closeDeleteDialog, confirmDelete } = useFileDeletion({
        activeWorktreeId,
        openFiles,
        closeFile,
        refreshDir,
        selectedPath,
        setSelectedPath,
        isMac,
        isWindows
    });
    const { handleMoveDrop, handleDragExpandDir, dropTargetDir, setDropTargetDir, dragSourcePath, setDragSourcePath, isRootDragOver, isNativeDragOver, nativeDropTargetDir, setNativeDropTargetDir, handleNativeDragExpandDir, stopDragEdgeScroll, rootDragHandlers, clearNativeDragState } = useFileExplorerDragDrop({
        worktreePath,
        activeWorktreeId,
        expanded,
        toggleDir,
        refreshDir,
        scrollRef
    });
    useEffect(() => {
        if (!worktreePath) {
            return;
        }
        setSelectedPath(null);
        resetAndLoad();
        clearFileExplorerUndoHistory();
    }, [worktreePath]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => clearFlashTimeout, [clearFlashTimeout]);
    useEffect(() => {
        for (const dirPath of expanded) {
            if (!dirCache[dirPath]?.children.length && !dirCache[dirPath]?.loading) {
                const depth = worktreePath
                    ? splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
                    : 0;
                void loadDir(dirPath, depth);
            }
        }
    }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps
    const { inlineInput, inlineInputIndex, startNew, startRename, dismissInlineInput, handleInlineSubmit } = useFileExplorerInlineInput({
        activeWorktreeId,
        worktreePath,
        expanded,
        flatRows,
        scrollRef,
        refreshDir
    });
    useFileExplorerWatch({
        worktreePath,
        activeWorktreeId,
        dirCache,
        setDirCache,
        expanded,
        setSelectedPath,
        refreshDir,
        refreshTree,
        inlineInput,
        dragSourcePath
    });
    useFileExplorerImport({
        worktreePath,
        activeWorktreeId,
        refreshDir,
        clearNativeDragState
    });
    const totalCount = flatRows.length + (inlineInputIndex >= 0 ? 1 : 0);
    const virtualizer = useVirtualizer({
        count: totalCount,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 26,
        overscan: 20,
        getItemKey: (index) => {
            if (inlineInputIndex >= 0) {
                if (index === inlineInputIndex) {
                    return '__inline_input__';
                }
                const rowIndex = index > inlineInputIndex ? index - 1 : index;
                return flatRows[rowIndex]?.path ?? `__fallback_${index}`;
            }
            return flatRows[index]?.path ?? `__fallback_${index}`;
        }
    });
    useFileExplorerReveal({
        activeWorktreeId,
        worktreePath,
        pendingExplorerReveal,
        clearPendingExplorerReveal,
        expanded,
        dirCache,
        rootCache,
        rowsByPath,
        flatRows,
        loadDir,
        setSelectedPath,
        setFlashingPath,
        flashTimeoutRef,
        virtualizer
    });
    useFileExplorerAutoReveal({
        activeFileId,
        activeWorktreeId,
        worktreePath,
        pendingExplorerReveal,
        openFiles,
        rowsByPath,
        flatRows,
        setSelectedPath,
        virtualizer
    });
    useEffect(() => {
        if (inlineInputIndex >= 0) {
            virtualizer.scrollToIndex(inlineInputIndex, { align: 'auto' });
        }
    }, [inlineInputIndex, virtualizer]);
    const selectedNode = selectedPath ? (rowsByPath.get(selectedPath) ?? null) : null;
    useFileExplorerKeys({
        containerRef: explorerShellRef,
        flatRows,
        inlineInput,
        selectedNode,
        startRename,
        requestDelete
    });
    const { handleClick, handleDoubleClick, handleWheelCapture } = useFileExplorerHandlers({
        activeWorktreeId,
        openFile,
        pinFile,
        toggleDir,
        setSelectedPath,
        scrollRef
    });
    const handleDuplicate = useFileDuplicate({ worktreePath, refreshDir });
    if (!worktreePath) {
        return (_jsx("div", { className: "flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center", children: "Select a worktree to browse files" }));
    }
    // Why: the root explorer container must stay mounted for loading, error,
    // and empty states so the data-native-file-drop-target marker is always
    // present. Without this, external file drops would have no target surface
    // when the tree is empty, still loading, or showing a read error.
    const isEmptyState = flatRows.length === 0 && !inlineInput;
    const isLoading = isEmptyState && (rootCache?.loading ?? true);
    const hasError = isEmptyState && !isLoading && !!rootError;
    const isEmpty = isEmptyState && !isLoading && !hasError;
    const showTree = !isEmptyState;
    return (_jsxs(_Fragment, { children: [_jsx("div", { ref: explorerShellRef, "data-orca-explorer-shell": true, className: "flex h-full min-h-0 flex-col", children: _jsxs(ScrollArea, { className: cn('h-full min-h-0', isRootDragOver &&
                        !(dragSourcePath && dirname(dragSourcePath) === worktreePath) &&
                        'bg-border', isNativeDragOver && !nativeDropTargetDir && 'bg-border'), viewportRef: scrollRef, viewportTabIndex: -1, viewportClassName: "h-full min-h-0 py-2", "data-native-file-drop-target": "file-explorer", "data-native-file-drop-dir": worktreePath, onWheelCapture: handleWheelCapture, onDragOver: rootDragHandlers.onDragOver, onDragEnter: rootDragHandlers.onDragEnter, onDragLeave: rootDragHandlers.onDragLeave, onDrop: rootDragHandlers.onDrop, onDragEnd: () => {
                        stopDragEdgeScroll();
                        setDropTargetDir(null);
                    }, onContextMenu: (e) => {
                        const target = e.target;
                        if (target.closest('[data-slot="context-menu-trigger"]')) {
                            return;
                        }
                        e.preventDefault();
                        setBgMenuPoint({ x: e.clientX, y: e.clientY });
                        setBgMenuOpen(true);
                    }, children: [isLoading && (_jsx("div", { className: "flex items-center justify-center h-full text-[11px] text-muted-foreground", children: _jsx(Loader2, { className: "size-4 animate-spin" }) })), hasError && (_jsxs("div", { className: "flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground", children: ["Could not load files for this worktree: ", rootError] })), isEmpty && (_jsx("div", { className: "flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center", children: "No files in this worktree" })), showTree && (_jsx(FileExplorerVirtualRows, { virtualizer: virtualizer, inlineInputIndex: inlineInputIndex, flatRows: flatRows, inlineInput: inlineInput, handleInlineSubmit: handleInlineSubmit, dismissInlineInput: dismissInlineInput, folderStatusByRelativePath: folderStatusByRelativePath, statusByRelativePath: statusByRelativePath, expanded: expanded, dirCache: dirCache, selectedPath: selectedPath, activeFileId: activeFileId, flashingPath: flashingPath, deleteShortcutLabel: deleteShortcutLabel, onClick: handleClick, onDoubleClick: handleDoubleClick, onSelectPath: setSelectedPath, onStartNew: startNew, onStartRename: startRename, onDuplicate: handleDuplicate, onRequestDelete: requestDelete, onMoveDrop: handleMoveDrop, onDragTargetChange: setDropTargetDir, onDragSourceChange: setDragSourcePath, onDragExpandDir: handleDragExpandDir, onNativeDragTargetChange: setNativeDropTargetDir, onNativeDragExpandDir: handleNativeDragExpandDir, dropTargetDir: dropTargetDir, dragSourcePath: dragSourcePath, nativeDropTargetDir: nativeDropTargetDir }))] }) }), _jsx(FileExplorerBackgroundMenu, { open: bgMenuOpen, onOpenChange: setBgMenuOpen, point: bgMenuPoint, worktreePath: worktreePath, onStartNew: startNew }), _jsx(FileDeleteDialog, { pendingDelete: pendingDelete, isDeleting: isDeleting, deleteDescription: deleteDescription, deleteActionLabel: deleteActionLabel, onClose: closeDeleteDialog, onConfirm: () => void confirmDelete() })] }));
}
export default React.memo(FileExplorerInner);
