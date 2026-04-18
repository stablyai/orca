import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef } from 'react';
import { ChevronRight, Copy, ExternalLink, File, FilePlus, Files, Folder, FolderOpen, FolderPlus, Loader2, Pencil, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { STATUS_LABELS } from './status-display';
import { useFileExplorerRowDrag } from './useFileExplorerRowDrag';
const ORCA_PATH_MIME = 'text/x-orca-file-path';
const isMac = navigator.userAgent.includes('Mac');
const isLinux = navigator.userAgent.includes('Linux');
/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
    ? 'Reveal in Finder'
    : isLinux
        ? 'Open Containing Folder'
        : 'Reveal in File Explorer';
// ─── Inline Input Row ────────────────────────────────────────────
export function InlineInputRow({ depth, inlineInput, onSubmit, onCancel }) {
    const inputRef = useRef(null);
    const blurTimeout = useRef(null);
    const submitted = useRef(false);
    // Grace period flag: when a menu (context or dropdown) closes, its focus
    // management can momentarily steal focus from this input before the user
    // has a chance to type. During the grace window we re-focus on blur instead
    // of auto-submitting, which would dismiss the empty input.
    const focusSettled = useRef(false);
    const settleTimer = useRef(null);
    useEffect(() => {
        submitted.current = false;
        focusSettled.current = false;
        // Schedule focus after any pending focus-restore from menu close
        const raf = requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) {
                return;
            }
            el.focus();
            if (inlineInput.type === 'rename' && inlineInput.existingName) {
                const dotIndex = inlineInput.existingName.lastIndexOf('.');
                if (dotIndex > 0) {
                    el.setSelectionRange(0, dotIndex);
                }
                else {
                    el.select();
                }
            }
            // Allow enough time for the menu close focus management to finish
            // before treating blur events as intentional user actions.
            settleTimer.current = setTimeout(() => {
                settleTimer.current = null;
                focusSettled.current = true;
            }, 200);
        });
        return () => {
            cancelAnimationFrame(raf);
            if (blurTimeout.current) {
                clearTimeout(blurTimeout.current);
            }
            if (settleTimer.current) {
                clearTimeout(settleTimer.current);
            }
        };
    }, [inlineInput]);
    const clearBlurTimeout = useCallback(() => {
        if (blurTimeout.current) {
            clearTimeout(blurTimeout.current);
            blurTimeout.current = null;
        }
    }, []);
    const submit = useCallback((value) => {
        if (submitted.current) {
            return;
        }
        submitted.current = true;
        clearBlurTimeout();
        onSubmit(value);
    }, [onSubmit, clearBlurTimeout]);
    return (_jsxs("div", { className: "flex items-center w-full h-[26px] px-2 gap-1", style: { paddingLeft: `${depth * 16 + 8}px` }, children: [_jsx("span", { className: "size-3 shrink-0" }), inlineInput.type === 'folder' ? (_jsx(Folder, { className: "size-3 shrink-0 text-muted-foreground" })) : (_jsx(File, { className: "size-3 shrink-0 text-muted-foreground" })), _jsx("input", { ref: inputRef, className: "flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border border-ring rounded-sm px-1", defaultValue: inlineInput.type === 'rename' ? inlineInput.existingName : '', onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        submit(e.currentTarget.value);
                    }
                    else if (e.key === 'Escape') {
                        clearBlurTimeout();
                        submitted.current = true;
                        onCancel();
                    }
                }, onFocus: clearBlurTimeout, onBlur: (e) => {
                    // When a Radix menu (context or dropdown) closes, it restores focus
                    // to its trigger button, which steals focus from this input before
                    // the user can type. Detect this by checking relatedTarget — if focus
                    // moved to any menu trigger, it's Radix cleanup, not a user action.
                    if (e.relatedTarget instanceof HTMLElement &&
                        (e.relatedTarget.closest('[data-slot="context-menu-trigger"]') ||
                            e.relatedTarget.closest('[data-slot="dropdown-menu-trigger"]'))) {
                        requestAnimationFrame(() => inputRef.current?.focus());
                        return;
                    }
                    // During the grace period after mount, menu close focus management
                    // may shift focus away (often relatedTarget is null). Re-focus
                    // instead of dismissing the still-empty input.
                    if (!focusSettled.current) {
                        requestAnimationFrame(() => inputRef.current?.focus());
                        return;
                    }
                    const value = e.currentTarget.value;
                    blurTimeout.current = setTimeout(() => {
                        blurTimeout.current = null;
                        submit(value);
                    }, 150);
                } })] }));
}
export function FileExplorerRow({ node, isExpanded, isLoading, isSelected, isFlashing, nodeStatus, statusColor, deleteShortcutLabel, targetDir, targetDepth, onClick, onDoubleClick, onSelect, onStartNew, onStartRename, onDuplicate, onRequestDelete, onMoveDrop, onDragTargetChange, onDragSourceChange, onDragExpandDir, onNativeDragTargetChange, onNativeDragExpandDir }) {
    const rowDropDir = node.isDirectory ? node.path : targetDir;
    const { handleDragOver, handleDragEnter, handleDragLeave, handleDrop } = useFileExplorerRowDrag({
        rowDropDir,
        isDirectory: node.isDirectory,
        nodePath: node.path,
        isExpanded,
        onDragTargetChange,
        onDragExpandDir,
        onNativeDragTargetChange,
        onNativeDragExpandDir,
        onMoveDrop
    });
    return (_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsxs("button", { className: cn('flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-foreground', isSelected && 'bg-accent text-accent-foreground', isFlashing && 'bg-amber-400/20 ring-1 ring-inset ring-amber-400/70'), style: { paddingLeft: `${node.depth * 16 + 8}px` }, "data-native-file-drop-dir": rowDropDir, draggable: true, onDragStart: (event) => {
                        event.dataTransfer.setData(ORCA_PATH_MIME, node.path);
                        // Allow both file explorer moving and copying to terminal
                        event.dataTransfer.effectAllowed = 'copyMove';
                        onDragSourceChange(node.path);
                    }, onDragEnd: () => onDragSourceChange(null), onDragOver: handleDragOver, onDragEnter: handleDragEnter, onDragLeave: handleDragLeave, onDrop: handleDrop, onClick: onClick, onDoubleClick: onDoubleClick, onFocus: onSelect, onContextMenu: onSelect, children: [node.isDirectory ? (_jsxs(_Fragment, { children: [_jsx(ChevronRight, { className: cn('size-3 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90') }), isLoading ? (_jsx(Loader2, { className: "size-3 shrink-0 animate-spin text-muted-foreground" })) : isExpanded ? (_jsx(FolderOpen, { className: "size-3 shrink-0 text-muted-foreground" })) : (_jsx(Folder, { className: "size-3 shrink-0 text-muted-foreground" }))] })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: "size-3 shrink-0" }), _jsx(File, { className: "size-3 shrink-0 text-muted-foreground" })] })), _jsx("span", { className: cn('truncate', isSelected && !nodeStatus && 'text-accent-foreground'), style: nodeStatus ? { color: statusColor ?? undefined } : undefined, onDoubleClick: (e) => {
                                // Why: the row itself swallows double-click for "pin preview" /
                                // directory toggle. Scope rename to the filename text only so
                                // those behaviors stay intact on the icon and empty row area,
                                // matching VS Code's rename hotspot.
                                e.stopPropagation();
                                onStartRename(node);
                            }, children: node.name }), nodeStatus && (_jsx("span", { className: "ml-auto shrink-0 text-[10px] font-semibold tracking-wide mr-2", style: { color: statusColor ?? undefined }, children: STATUS_LABELS[nodeStatus] }))] }) }), _jsxs(ContextMenuContent, { className: "w-64 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)]", onCloseAutoFocus: (e) => e.preventDefault(), children: [_jsxs(ContextMenuItem, { onSelect: () => onStartNew('file', targetDir, targetDepth), children: [_jsx(FilePlus, {}), "New File"] }), _jsxs(ContextMenuItem, { onSelect: () => onStartNew('folder', targetDir, targetDepth), children: [_jsx(FolderPlus, {}), "New Folder"] }), _jsx(ContextMenuSeparator, {}), _jsxs(ContextMenuItem, { onSelect: () => window.api.ui.writeClipboardText(node.path), children: [_jsx(Copy, {}), "Copy Path", _jsx(ContextMenuShortcut, { children: isMac ? '⌥⌘C' : 'Shift+Alt+C' })] }), _jsxs(ContextMenuItem, { onSelect: () => window.api.ui.writeClipboardText(node.relativePath), children: [_jsx(Copy, {}), "Copy Relative Path", _jsx(ContextMenuShortcut, { children: isMac ? '⌥⇧⌘C' : 'Ctrl+Shift+Alt+C' })] }), !node.isDirectory && (_jsxs(ContextMenuItem, { onSelect: () => onDuplicate(node), children: [_jsx(Files, {}), "Duplicate"] })), _jsxs(ContextMenuItem, { onSelect: () => window.api.shell.openPath(node.path), children: [_jsx(ExternalLink, {}), revealLabel] }), _jsx(ContextMenuSeparator, {}), _jsxs(ContextMenuItem, { onSelect: () => onStartRename(node), children: [_jsx(Pencil, {}), "Rename", _jsx(ContextMenuShortcut, { children: isMac ? '↩' : 'Enter' })] }), _jsxs(ContextMenuItem, { variant: "destructive", onSelect: onRequestDelete, children: [_jsx(Trash2, {}), "Delete", _jsx(ContextMenuShortcut, { children: deleteShortcutLabel })] })] })] }));
}
