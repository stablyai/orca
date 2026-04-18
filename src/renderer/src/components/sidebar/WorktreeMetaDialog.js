import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links';
const WorktreeMetaDialog = React.memo(function WorktreeMetaDialog() {
    const activeModal = useAppStore((s) => s.activeModal);
    const modalData = useAppStore((s) => s.modalData);
    const closeModal = useAppStore((s) => s.closeModal);
    const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta);
    const isEditMeta = activeModal === 'edit-meta';
    const isOpen = isEditMeta;
    const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : '';
    const currentDisplayName = typeof modalData.currentDisplayName === 'string' ? modalData.currentDisplayName : '';
    const currentIssue = typeof modalData.currentIssue === 'number' ? String(modalData.currentIssue) : '';
    const currentComment = typeof modalData.currentComment === 'string' ? modalData.currentComment : '';
    const focusField = typeof modalData.focus === 'string' ? modalData.focus : 'comment';
    const [displayNameInput, setDisplayNameInput] = useState('');
    const [issueInput, setIssueInput] = useState('');
    const [commentInput, setCommentInput] = useState('');
    const [saving, setSaving] = useState(false);
    const isMac = navigator.userAgent.includes('Mac');
    const issueInputRef = useRef(null);
    const textareaRef = useRef(null);
    const prevIsOpenRef = useRef(false);
    const displayNameInputRef = useRef(null);
    if (isOpen && !prevIsOpenRef.current) {
        setDisplayNameInput(currentDisplayName);
        setIssueInput(currentIssue);
        setCommentInput(currentComment);
    }
    prevIsOpenRef.current = isOpen;
    const autoResize = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) {
            return;
        }
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
    }, []);
    useEffect(() => {
        if (isEditMeta) {
            autoResize();
        }
    }, [isEditMeta, commentInput, autoResize]);
    const canSave = useMemo(() => {
        if (!worktreeId) {
            return false;
        }
        return issueInput.trim() === '' || parseGitHubIssueOrPRNumber(issueInput) !== null;
    }, [worktreeId, issueInput]);
    const handleOpenChange = useCallback((open) => {
        if (!open) {
            closeModal();
        }
    }, [closeModal]);
    const handleSave = useCallback(async () => {
        if (!worktreeId) {
            return;
        }
        setSaving(true);
        try {
            const trimmedIssue = issueInput.trim();
            const linkedIssueNumber = parseGitHubIssueOrPRNumber(trimmedIssue);
            const finalLinkedIssue = trimmedIssue === '' ? null : linkedIssueNumber !== null ? linkedIssueNumber : undefined;
            const trimmedDisplayName = displayNameInput.trim();
            const updates = {
                comment: commentInput.trim(),
                ...(trimmedDisplayName !== currentDisplayName && {
                    displayName: trimmedDisplayName || undefined
                })
            };
            if (finalLinkedIssue !== undefined) {
                updates.linkedIssue = finalLinkedIssue;
            }
            await updateWorktreeMeta(worktreeId, updates);
            closeModal();
        }
        finally {
            setSaving(false);
        }
    }, [
        worktreeId,
        displayNameInput,
        currentDisplayName,
        issueInput,
        commentInput,
        updateWorktreeMeta,
        closeModal
    ]);
    const handleCommentKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            e.stopPropagation();
            handleSave();
        }
    }, [handleSave]);
    const handleIssueKeyDown = useCallback((e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
    }, [handleSave]);
    return (_jsx(Dialog, { open: isOpen, onOpenChange: handleOpenChange, children: _jsxs(DialogContent, { className: "max-w-md", onOpenAutoFocus: (e) => {
                e.preventDefault();
                if (focusField === 'displayName') {
                    displayNameInputRef.current?.focus();
                }
                else if (focusField === 'issue') {
                    issueInputRef.current?.focus();
                }
                else {
                    textareaRef.current?.focus();
                }
            }, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Edit Worktree Details" }), _jsx(DialogDescription, { className: "text-xs", children: "Edit the GitHub issue link and notes for this worktree." })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "Display Name" }), _jsx(Input, { ref: displayNameInputRef, value: displayNameInput, onChange: (e) => setDisplayNameInput(e.target.value), onKeyDown: handleIssueKeyDown, placeholder: "Custom display name...", className: "h-8 text-xs" }), _jsx("p", { className: "text-[10px] text-muted-foreground", children: "Only changes the name shown in the sidebar \u2014 the folder on disk stays the same. Leave blank to use the branch or folder name." })] }), _jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "GH Issue" }), _jsx(Input, { ref: issueInputRef, value: issueInput, onChange: (e) => setIssueInput(e.target.value), onKeyDown: handleIssueKeyDown, placeholder: "Issue # or GitHub URL", className: "h-8 text-xs" }), _jsx("p", { className: "text-[10px] text-muted-foreground", children: "Paste an issue URL, or enter a number. Leave blank to remove the link." })] }), _jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "Comment" }), _jsx("textarea", { ref: textareaRef, value: commentInput, onChange: (e) => setCommentInput(e.target.value), onKeyDown: handleCommentKeyDown, placeholder: "Notes about this worktree...", rows: 3, className: "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto" }), _jsxs("p", { className: "text-[10px] text-muted-foreground", children: ["Supports **markdown** \u2014 bold, lists, `code`, links. Press Enter or", ' ', isMac ? 'Cmd' : 'Ctrl', "+Enter to save, Shift+Enter for a new line."] })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", size: "sm", onClick: () => handleOpenChange(false), className: "text-xs", children: "Cancel" }), _jsx(Button, { size: "sm", onClick: handleSave, disabled: !canSave || saving, className: "text-xs", children: saving ? 'Saving...' : 'Save' })] })] }) }));
});
export default WorktreeMetaDialog;
