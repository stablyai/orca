import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useCallback, useEffect, useState } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FolderOpen, Copy, Bell, BellOff, Link, MessageSquare, Pencil, Pin, PinOff, XCircle, Trash2 } from 'lucide-react';
import { useAppStore } from '@/store';
import { isFolderRepo } from '../../../../shared/repo-kind';
const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus';
const WorktreeContextMenu = React.memo(function WorktreeContextMenu({ worktree, children }) {
    const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta);
    const openModal = useAppStore((s) => s.openModal);
    const repos = useAppStore((s) => s.repos);
    const shutdownWorktreeTerminals = useAppStore((s) => s.shutdownWorktreeTerminals);
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const setActiveWorktree = useAppStore((s) => s.setActiveWorktree);
    const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState);
    const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id]);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 });
    const isDeleting = deleteState?.isDeleting ?? false;
    const repo = repos.find((entry) => entry.id === worktree.repoId);
    const isFolder = repo ? isFolderRepo(repo) : false;
    useEffect(() => {
        const closeMenu = () => setMenuOpen(false);
        window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
        return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
    }, []);
    const handleOpenInFinder = useCallback(() => {
        window.api.shell.openPath(worktree.path);
    }, [worktree.path]);
    const handleCopyPath = useCallback(() => {
        window.api.ui.writeClipboardText(worktree.path);
    }, [worktree.path]);
    const handleToggleRead = useCallback(() => {
        updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread });
    }, [worktree.id, worktree.isUnread, updateWorktreeMeta]);
    const handleTogglePin = useCallback(() => {
        updateWorktreeMeta(worktree.id, { isPinned: !worktree.isPinned });
    }, [worktree.id, worktree.isPinned, updateWorktreeMeta]);
    const handleRename = useCallback(() => {
        openModal('edit-meta', {
            worktreeId: worktree.id,
            currentDisplayName: worktree.displayName,
            currentIssue: worktree.linkedIssue,
            currentComment: worktree.comment,
            focus: 'displayName'
        });
    }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal]);
    const handleLinkIssue = useCallback(() => {
        openModal('edit-meta', {
            worktreeId: worktree.id,
            currentDisplayName: worktree.displayName,
            currentIssue: worktree.linkedIssue,
            currentComment: worktree.comment,
            focus: 'issue'
        });
    }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal]);
    const handleComment = useCallback(() => {
        openModal('edit-meta', {
            worktreeId: worktree.id,
            currentDisplayName: worktree.displayName,
            currentIssue: worktree.linkedIssue,
            currentComment: worktree.comment,
            focus: 'comment'
        });
    }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal]);
    const handleCloseTerminals = useCallback(async () => {
        // Why: shutting down the currently active worktree while its TerminalPane
        // is still visible causes a visible "reboot" flicker and can crash the
        // pane. clearTransientTerminalState nulls each tab's ptyId in place
        // without bumping generation, so TerminalPane stays mounted while its
        // PTYs are being killed; PTY exit callbacks then race against the live
        // xterm instance. Boot the user to the landing page FIRST so the visible
        // surface is detached before the async teardown runs.
        if (activeWorktreeId === worktree.id) {
            setActiveWorktree(null);
        }
        await shutdownWorktreeTerminals(worktree.id);
    }, [worktree.id, shutdownWorktreeTerminals, activeWorktreeId, setActiveWorktree]);
    const handleDelete = useCallback(() => {
        setMenuOpen(false);
        if (isFolder) {
            // Why: folder mode reuses the worktree row UI for a synthetic root entry,
            // but users still expect "remove" to disconnect the folder from Orca,
            // not to run git-style delete semantics against the real folder on disk.
            openModal('confirm-remove-folder', {
                repoId: worktree.repoId,
                displayName: worktree.displayName
            });
            return;
        }
        clearWorktreeDeleteState(worktree.id);
        openModal('delete-worktree', { worktreeId: worktree.id });
    }, [
        worktree.id,
        worktree.repoId,
        worktree.displayName,
        clearWorktreeDeleteState,
        isFolder,
        openModal
    ]);
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "relative", onContextMenuCapture: (event) => {
                    event.preventDefault();
                    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT));
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
                    setMenuOpen(true);
                }, children: children }), _jsxs(DropdownMenu, { open: menuOpen, onOpenChange: setMenuOpen, modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { "aria-hidden": true, tabIndex: -1, className: "pointer-events-none absolute size-px opacity-0", style: { left: menuPoint.x, top: menuPoint.y } }) }), _jsxs(DropdownMenuContent, { className: "w-52", sideOffset: 0, align: "start", children: [_jsxs(DropdownMenuItem, { onSelect: handleOpenInFinder, disabled: isDeleting, children: [_jsx(FolderOpen, { className: "size-3.5" }), "Open in Finder"] }), _jsxs(DropdownMenuItem, { onSelect: handleCopyPath, disabled: isDeleting, children: [_jsx(Copy, { className: "size-3.5" }), "Copy Path"] }), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: handleTogglePin, disabled: isDeleting, children: [worktree.isPinned ? _jsx(PinOff, { className: "size-3.5" }) : _jsx(Pin, { className: "size-3.5" }), worktree.isPinned ? 'Unpin' : 'Pin'] }), _jsxs(DropdownMenuItem, { onSelect: handleRename, disabled: isDeleting, children: [_jsx(Pencil, { className: "size-3.5" }), "Rename"] }), _jsxs(DropdownMenuItem, { onSelect: handleToggleRead, disabled: isDeleting, children: [worktree.isUnread ? _jsx(BellOff, { className: "size-3.5" }) : _jsx(Bell, { className: "size-3.5" }), worktree.isUnread ? 'Mark Read' : 'Mark Unread'] }), _jsxs(DropdownMenuItem, { onSelect: handleLinkIssue, disabled: isDeleting, children: [_jsx(Link, { className: "size-3.5" }), worktree.linkedIssue ? 'Edit GH Issue' : 'Link GH Issue'] }), _jsxs(DropdownMenuItem, { onSelect: handleComment, disabled: isDeleting, children: [_jsx(MessageSquare, { className: "size-3.5" }), worktree.comment ? 'Edit Comment' : 'Add Comment'] }), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: handleCloseTerminals, disabled: isDeleting, children: [_jsx(XCircle, { className: "size-3.5" }), "Shutdown"] }), _jsxs(DropdownMenuItem, { variant: "destructive", onSelect: handleDelete, disabled: isDeleting || (!isFolder && worktree.isMainWorktree), title: !isFolder && worktree.isMainWorktree
                                    ? 'The main worktree cannot be deleted'
                                    : undefined, children: [_jsx(Trash2, { className: "size-3.5" }), isDeleting ? 'Deleting…' : isFolder ? 'Remove Folder from Orca' : 'Delete'] })] })] })] }));
});
export default WorktreeContextMenu;
