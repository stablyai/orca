import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useEffect, useMemo, useCallback, useState } from 'react';
import { useAppStore } from '@/store';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Bell, GitMerge, LoaderCircle, CircleCheck, CircleX, Globe, WifiOff } from 'lucide-react';
import StatusIndicator from './StatusIndicator';
import CacheTimer from './CacheTimer';
import WorktreeContextMenu from './WorktreeContextMenu';
import { SshDisconnectedDialog } from './SshDisconnectedDialog';
import { cn } from '@/lib/utils';
import { getWorktreeStatus } from '@/lib/worktree-status';
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind';
import { branchDisplayName, checksLabel, CONFLICT_OPERATION_LABELS, EMPTY_TABS, EMPTY_BROWSER_TABS, FilledBellIcon } from './WorktreeCardHelpers';
import { IssueSection, PrSection, CommentSection } from './WorktreeCardMeta';
const WorktreeCard = React.memo(function WorktreeCard({ worktree, repo, isActive, hideRepoBadge, hintNumber }) {
    const setActiveWorktree = useAppStore((s) => s.setActiveWorktree);
    const setActiveView = useAppStore((s) => s.setActiveView);
    const openModal = useAppStore((s) => s.openModal);
    const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta);
    const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch);
    const fetchIssue = useAppStore((s) => s.fetchIssue);
    const cardProps = useAppStore((s) => s.worktreeCardProperties);
    const handleEditIssue = useCallback((e) => {
        e.stopPropagation();
        openModal('edit-meta', {
            worktreeId: worktree.id,
            currentDisplayName: worktree.displayName,
            currentIssue: worktree.linkedIssue,
            currentComment: worktree.comment,
            focus: 'issue'
        });
    }, [worktree, openModal]);
    const handleEditComment = useCallback((e) => {
        e.stopPropagation();
        openModal('edit-meta', {
            worktreeId: worktree.id,
            currentDisplayName: worktree.displayName,
            currentIssue: worktree.linkedIssue,
            currentComment: worktree.comment,
            focus: 'comment'
        });
    }, [worktree, openModal]);
    const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id]);
    const conflictOperation = useAppStore((s) => s.gitConflictOperationByWorktree[worktree.id]);
    // SSH disconnected state
    const sshStatus = useAppStore((s) => {
        if (!repo?.connectionId) {
            return null;
        }
        const state = s.sshConnectionStates.get(repo.connectionId);
        return state?.status ?? 'disconnected';
    });
    const isSshDisconnected = sshStatus != null && sshStatus !== 'connected';
    const [showDisconnectedDialog, setShowDisconnectedDialog] = useState(false);
    // Why: on restart the previously-active worktree is auto-restored without a
    // click, so the dialog never opens. Auto-show it for the active card when SSH
    // is disconnected so the user sees the reconnect prompt immediately.
    useEffect(() => {
        if (isActive && isSshDisconnected) {
            setShowDisconnectedDialog(true);
        }
    }, [isActive, isSshDisconnected]);
    // Why: read the target label from the store (populated during hydration in
    // useIpcEvents.ts) instead of calling listTargets IPC per card instance.
    const sshTargetLabel = useAppStore((s) => repo?.connectionId ? (s.sshTargetLabels.get(repo.connectionId) ?? '') : '');
    // ── GRANULAR selectors: only subscribe to THIS worktree's data ──
    const tabs = useAppStore((s) => s.tabsByWorktree[worktree.id] ?? EMPTY_TABS);
    const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktree.id] ?? EMPTY_BROWSER_TABS);
    const branch = branchDisplayName(worktree.branch);
    const isFolder = repo ? isFolderRepo(repo) : false;
    const prCacheKey = repo && branch ? `${repo.path}::${branch}` : '';
    const issueCacheKey = repo && worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : '';
    // Subscribe to ONLY the specific cache entry, not entire prCache/issueCache
    const prEntry = useAppStore((s) => (prCacheKey ? s.prCache[prCacheKey] : undefined));
    const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined));
    const pr = prEntry !== undefined ? prEntry.data : undefined;
    const issue = worktree.linkedIssue
        ? issueEntry !== undefined
            ? issueEntry.data
            : undefined
        : null;
    const isDeleting = deleteState?.isDeleting ?? false;
    // Derive status
    const status = useMemo(() => getWorktreeStatus(tabs, browserTabs), [tabs, browserTabs]);
    const showPR = cardProps.includes('pr');
    const showCI = cardProps.includes('ci');
    const showIssue = cardProps.includes('issue');
    // Skip GitHub fetches when the corresponding card sections are hidden.
    // This preference is purely presentational, so background refreshes would
    // spend rate limit budget on data the user cannot see.
    useEffect(() => {
        if (repo && !isFolder && !worktree.isBare && prCacheKey && (showPR || showCI)) {
            fetchPRForBranch(repo.path, branch);
        }
    }, [repo, isFolder, worktree.isBare, fetchPRForBranch, branch, prCacheKey, showPR, showCI]);
    // Same rationale for issues: once that section is hidden, polling only burns
    // GitHub calls and keeps stale-but-invisible data warm for no user benefit.
    useEffect(() => {
        if (!repo || isFolder || !worktree.linkedIssue || !issueCacheKey || !showIssue) {
            return;
        }
        fetchIssue(repo.path, worktree.linkedIssue);
        // Background poll as fallback (activity triggers handle the fast path)
        const interval = setInterval(() => {
            fetchIssue(repo.path, worktree.linkedIssue);
        }, 5 * 60_000); // 5 minutes
        return () => clearInterval(interval);
    }, [repo, isFolder, worktree.linkedIssue, fetchIssue, issueCacheKey, showIssue]);
    // Stable click handler – ignore clicks that are really text selections.
    // Why: if the SSH connection is down, show a reconnect dialog instead of
    // activating the worktree — all remote operations would fail anyway.
    const handleClick = useCallback(() => {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            return;
        }
        if (useAppStore.getState().activeView !== 'terminal') {
            // Why: the sidebar remains visible during the new-workspace flow, so
            // clicking a real worktree should switch the main pane back to that
            // worktree instead of leaving the create surface visible.
            setActiveView('terminal');
        }
        // Why: always activate the worktree so the user can see terminal history,
        // editor state, etc. even when SSH is disconnected. Show the reconnect
        // dialog as a non-blocking overlay rather than a gate.
        setActiveWorktree(worktree.id);
        if (isSshDisconnected) {
            setShowDisconnectedDialog(true);
        }
    }, [worktree.id, setActiveView, setActiveWorktree, isSshDisconnected]);
    const handleDoubleClick = useCallback(() => {
        openModal('edit-meta', {
            worktreeId: worktree.id,
            currentDisplayName: worktree.displayName,
            currentIssue: worktree.linkedIssue,
            currentComment: worktree.comment
        });
    }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal]);
    const handleToggleUnreadQuick = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread });
    }, [worktree.id, worktree.isUnread, updateWorktreeMeta]);
    const unreadTooltip = worktree.isUnread ? 'Mark read' : 'Mark unread';
    return (_jsxs(_Fragment, { children: [_jsx(WorktreeContextMenu, { worktree: worktree, children: _jsxs("div", { className: cn('group relative flex items-start gap-2.5 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none ml-1', isActive
                        ? 'bg-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.03)] border border-border/60 dark:bg-white/[0.10] dark:border-border/40'
                        : 'border border-transparent hover:bg-accent/40', isDeleting && 'opacity-50 grayscale cursor-not-allowed', isSshDisconnected && !isDeleting && 'opacity-60'), onClick: handleClick, onDoubleClick: handleDoubleClick, "aria-busy": isDeleting, children: [isDeleting && (_jsx("div", { className: "absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]", children: _jsxs("div", { className: "inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50", children: [_jsx(LoaderCircle, { className: "size-3.5 animate-spin text-muted-foreground" }), "Deleting\u2026"] }) })), hintNumber != null && (_jsx("div", { "aria-hidden": "true", className: "absolute -left-1 top-1/2 z-20 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded bg-zinc-500/85 text-white shadow-sm animate-in fade-in zoom-in-75 duration-150", children: _jsx("span", { className: "relative block pt-px text-[9px] leading-none font-medium [font-variant-numeric:tabular-nums]", children: hintNumber }) })), (cardProps.includes('status') || cardProps.includes('unread')) && (_jsxs("div", { className: "flex flex-col items-center justify-start pt-[2px] gap-2 shrink-0", children: [cardProps.includes('status') && _jsx(StatusIndicator, { status: status }), cardProps.includes('unread') && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { type: "button", onClick: handleToggleUnreadQuick, className: cn('group/unread flex size-4 cursor-pointer items-center justify-center rounded transition-all', 'hover:bg-accent/80 active:scale-95', 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'), "aria-label": worktree.isUnread ? 'Mark as read' : 'Mark as unread', children: worktree.isUnread ? (_jsx(FilledBellIcon, { className: "size-[13px] text-amber-500 drop-shadow-sm" })) : (_jsx(Bell, { className: "size-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 group-hover/unread:opacity-100 transition-opacity" })) }) }), _jsx(TooltipContent, { side: "right", sideOffset: 8, children: _jsx("span", { children: unreadTooltip }) })] }))] })), _jsxs("div", { className: "flex-1 min-w-0 flex flex-col gap-1.5", children: [_jsxs("div", { className: "flex items-center justify-between min-w-0 gap-2", children: [_jsxs("div", { className: "flex items-center gap-1.5 min-w-0", children: [_jsx("div", { className: "text-[12px] font-semibold text-foreground truncate leading-tight", children: worktree.displayName }), worktree.isMainWorktree && !isFolder && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Badge, { variant: "outline", className: "h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-muted-foreground border-muted-foreground/30 bg-muted-foreground/5", children: "primary" }) }), _jsx(TooltipContent, { side: "right", sideOffset: 8, children: "Primary worktree (original clone directory)" })] }))] }), cardProps.includes('ci') && pr && pr.checksStatus !== 'neutral' && (_jsx("div", { className: "flex items-center gap-2 shrink-0", children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs("span", { className: "inline-flex items-center opacity-80 hover:opacity-100 transition-opacity", children: [pr.checksStatus === 'success' && (_jsx(CircleCheck, { className: "size-3.5 text-emerald-500" })), pr.checksStatus === 'failure' && (_jsx(CircleX, { className: "size-3.5 text-rose-500" })), pr.checksStatus === 'pending' && (_jsx(LoaderCircle, { className: "size-3.5 text-amber-500 animate-spin" }))] }) }), _jsx(TooltipContent, { side: "right", sideOffset: 8, children: _jsxs("span", { children: ["CI checks ", checksLabel(pr.checksStatus).toLowerCase()] }) })] }) }))] }), _jsxs("div", { className: "flex items-center gap-1.5 min-w-0", children: [repo && !hideRepoBadge && (_jsxs("div", { className: "flex items-center gap-1.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60", children: [_jsx("div", { className: "size-1.5 rounded-full", style: { backgroundColor: repo.badgeColor } }), _jsx("span", { className: "text-[10px] font-semibold text-foreground truncate max-w-[6rem] leading-none lowercase", children: repo.displayName })] })), repo?.connectionId && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("span", { className: "shrink-0 inline-flex items-center gap-0.5", children: isSshDisconnected ? (_jsx(WifiOff, { className: "size-3 text-red-400" })) : (_jsx(Globe, { className: "size-3 text-muted-foreground" })) }) }), _jsx(TooltipContent, { side: "right", sideOffset: 8, children: isSshDisconnected ? 'SSH disconnected' : 'Remote repository via SSH' })] })), isFolder ? (_jsx(Badge, { variant: "secondary", className: "h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 text-muted-foreground bg-accent border border-border dark:bg-accent/80 dark:border-border/50 leading-none", children: repo ? getRepoKindLabel(repo) : 'Folder' })) : (_jsx("span", { className: "text-[11px] text-muted-foreground truncate leading-none", children: branch })), conflictOperation && conflictOperation !== 'unknown' && (_jsxs(Badge, { variant: "outline", className: "h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 gap-1 text-amber-600 border-amber-500/30 bg-amber-500/5 dark:text-amber-400 dark:border-amber-400/30 dark:bg-amber-400/5 leading-none", children: [_jsx(GitMerge, { className: "size-2.5" }), CONFLICT_OPERATION_LABELS[conflictOperation]] })), _jsx(CacheTimer, { worktreeId: worktree.id })] }), ((cardProps.includes('issue') && issue) ||
                                    (cardProps.includes('pr') && pr) ||
                                    (cardProps.includes('comment') && worktree.comment)) && (_jsxs("div", { className: "flex flex-col gap-[3px] mt-0.5", children: [cardProps.includes('issue') && issue && (_jsx(IssueSection, { issue: issue, onClick: handleEditIssue })), cardProps.includes('pr') && pr && _jsx(PrSection, { pr: pr, onClick: handleEditIssue }), cardProps.includes('comment') && worktree.comment && (_jsx(CommentSection, { comment: worktree.comment, onDoubleClick: handleEditComment }))] }))] })] }) }), repo?.connectionId && (_jsx(SshDisconnectedDialog, { open: showDisconnectedDialog && isSshDisconnected, onOpenChange: setShowDisconnectedDialog, targetId: repo.connectionId, targetLabel: sshTargetLabel || repo.displayName, status: sshStatus ?? 'disconnected' }))] }));
});
export default WorktreeCard;
