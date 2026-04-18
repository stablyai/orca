import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, GitMerge, ChevronDown, Trash2 } from 'lucide-react';
import { useAppStore } from '@/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
const MERGE_METHODS = ['squash', 'merge', 'rebase'];
const MERGE_LABELS = {
    squash: 'Squash and merge',
    merge: 'Create a merge commit',
    rebase: 'Rebase and merge'
};
export default function PRActions({ pr, repo, worktree, onRefreshPR }) {
    const openModal = useAppStore((s) => s.openModal);
    const [merging, setMerging] = useState(false);
    const [mergeError, setMergeError] = useState(null);
    const [mergeMenuOpen, setMergeMenuOpen] = useState(false);
    const mergeMenuRef = useRef(null);
    const handleMerge = useCallback(async (method = 'squash') => {
        setMerging(true);
        setMergeError(null);
        setMergeMenuOpen(false);
        try {
            const result = await window.api.gh.mergePR({
                repoPath: repo.path,
                prNumber: pr.number,
                method
            });
            if (!result.ok) {
                setMergeError(result.error);
            }
            else {
                await onRefreshPR();
            }
        }
        catch (err) {
            setMergeError(err instanceof Error ? err.message : 'Merge failed');
        }
        finally {
            setMerging(false);
        }
    }, [repo.path, pr.number, onRefreshPR]);
    useEffect(() => {
        if (!mergeMenuOpen) {
            return;
        }
        const handleClickOutside = (e) => {
            if (mergeMenuRef.current && !mergeMenuRef.current.contains(e.target)) {
                setMergeMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [mergeMenuOpen]);
    const handleDeleteWorktree = useCallback(() => {
        openModal('delete-worktree', { worktreeId: worktree.id });
    }, [worktree.id, openModal]);
    // Why: merging a PR with unresolved conflicts would fail on GitHub anyway;
    // disabling the button prevents a confusing error and signals the user must
    // resolve conflicts first.
    const hasConflicts = pr.mergeable === 'CONFLICTING';
    if (pr.state === 'open') {
        return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(TooltipProvider, { delayDuration: 300, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("span", { className: cn(hasConflicts && 'cursor-not-allowed'), children: _jsxs("div", { className: cn('relative flex items-stretch', hasConflicts && 'pointer-events-none'), ref: mergeMenuRef, children: [_jsxs(Button, { type: "button", size: "xs", className: cn('flex-1 rounded-r-none px-3 text-[11px]', 'bg-green-600 text-white hover:bg-green-700', 'disabled:opacity-50 disabled:cursor-not-allowed'), onClick: () => void handleMerge('squash'), disabled: merging || hasConflicts, children: [merging ? (_jsx(LoaderCircle, { className: "size-3.5 animate-spin" })) : (_jsx(GitMerge, { className: "size-3.5" })), merging ? 'Merging\u2026' : 'Squash and merge'] }), _jsx(Button, { type: "button", size: "xs", className: cn('rounded-l-none border-l border-green-700/50 px-1.5', 'bg-green-600 text-white hover:bg-green-700', 'disabled:opacity-50 disabled:cursor-not-allowed'), onClick: () => setMergeMenuOpen((v) => !v), disabled: merging || hasConflicts, children: _jsx(ChevronDown, { className: "size-3.5" }) }), mergeMenuOpen && (_jsx("div", { className: "absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-border bg-popover shadow-md overflow-hidden", children: MERGE_METHODS.map((method) => (_jsx(Button, { type: "button", variant: "ghost", size: "xs", className: "h-auto w-full justify-start rounded-none px-3 py-1 text-left text-[11px]", onClick: () => void handleMerge(method), children: MERGE_LABELS[method] }, method))) }))] }) }) }), hasConflicts && (_jsx(TooltipContent, { side: "bottom", sideOffset: 4, children: "Merge conflicts must be resolved before merging" }))] }) }), mergeError && _jsx("div", { className: "text-[10px] text-rose-500 break-words", children: mergeError })] }));
    }
    if (pr.state === 'merged') {
        return (_jsxs(Button, { type: "button", variant: "secondary", size: "xs", className: "w-full text-[11px]", onClick: handleDeleteWorktree, children: [_jsx(Trash2, { className: "size-3.5" }), "Delete Worktree"] }));
    }
    return null;
}
