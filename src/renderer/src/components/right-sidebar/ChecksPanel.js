import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: the checks panel co-locates PR header, checks, comments,
merge actions, and conflict state in one component to keep the data flow straightforward. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, ExternalLink, RefreshCw, Check, X, Pencil } from 'lucide-react';
import { useAppStore } from '@/store';
import { cn } from '@/lib/utils';
import { isFolderRepo } from '../../../../shared/repo-kind';
import PRActions from './PRActions';
import { PullRequestIcon, prStateColor, ConflictingFilesSection, MergeConflictNotice, ChecksList, PRCommentsList } from './checks-helpers';
export default function ChecksPanel() {
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const worktreesByRepo = useAppStore((s) => s.worktreesByRepo);
    const repos = useAppStore((s) => s.repos);
    const prCache = useAppStore((s) => s.prCache);
    const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch);
    const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree);
    // Why: the sidebar stays mounted when closed (for performance). Gate
    // polling on visibility so we don't fetch checks/comments in the background
    // when the panel isn't visible to the user.
    const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen);
    const rightSidebarTab = useAppStore((s) => s.rightSidebarTab);
    const isPanelVisible = rightSidebarOpen && rightSidebarTab === 'checks';
    const fetchPRChecks = useAppStore((s) => s.fetchPRChecks);
    const fetchPRComments = useAppStore((s) => s.fetchPRComments);
    const resolveReviewThread = useAppStore((s) => s.resolveReviewThread);
    const [checks, setChecks] = useState([]);
    const [checksLoading, setChecksLoading] = useState(false);
    const [comments, setComments] = useState([]);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [emptyRefreshing, setEmptyRefreshing] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const [titleSaving, setTitleSaving] = useState(false);
    const titleInputRef = useRef(null);
    const pollRef = useRef(null);
    const pollIntervalRef = useRef(30_000); // start at 30s, backs off to 120s
    const prevChecksRef = useRef('');
    const conflictSummaryRefreshKeyRef = useRef(null);
    // Why: the sidebar no longer uses key={activeWorktreeId} to force a full
    // remount on worktree switch (that caused an IPC storm on Windows).
    // Reset worktree-specific local state so stale UI from the previous
    // worktree doesn't leak (e.g. mid-edit title, stale loading indicators).
    // Done during render (not useEffect) so the reset takes effect on the same
    // paint as the worktree change — useEffect would leave one render with the
    // previous worktree's stale title/loading state visible.
    const [prevActiveWorktreeId, setPrevActiveWorktreeId] = useState(activeWorktreeId);
    if (activeWorktreeId !== prevActiveWorktreeId) {
        setPrevActiveWorktreeId(activeWorktreeId);
        setEditingTitle(false);
        setTitleDraft('');
        setTitleSaving(false);
        setIsRefreshing(false);
        setEmptyRefreshing(false);
        conflictSummaryRefreshKeyRef.current = null;
    }
    // Find active worktree and repo
    const { worktree, repo } = useMemo(() => {
        if (!activeWorktreeId) {
            return { worktree: null, repo: null };
        }
        for (const worktrees of Object.values(worktreesByRepo)) {
            const wt = worktrees.find((w) => w.id === activeWorktreeId);
            if (wt) {
                const r = repos.find((rp) => rp.id === wt.repoId);
                return { worktree: wt, repo: r ?? null };
            }
        }
        return { worktree: null, repo: null };
    }, [activeWorktreeId, worktreesByRepo, repos]);
    const branch = worktree ? worktree.branch.replace(/^refs\/heads\//, '') : '';
    const isFolder = repo ? isFolderRepo(repo) : false;
    const prCacheKey = repo && branch ? `${repo.path}::${branch}` : '';
    const pr = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null;
    const prNumber = pr?.number ?? null;
    const conflictOperation = activeWorktreeId
        ? (gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown')
        : 'unknown';
    // Fetch PR data when the active worktree/branch changes
    useEffect(() => {
        if (repo && !isFolder && branch) {
            void fetchPRForBranch(repo.path, branch);
        }
    }, [repo, isFolder, branch, fetchPRForBranch]);
    useEffect(() => {
        if (!repo || isFolder || !branch || !pr || pr.mergeable !== 'CONFLICTING') {
            conflictSummaryRefreshKeyRef.current = null;
            return;
        }
        const refreshKey = `${repo.path}::${branch}::${pr.number}`;
        if (conflictSummaryRefreshKeyRef.current === refreshKey) {
            return;
        }
        // Why: the checks panel is the one place where stale conflict metadata is
        // visibly wrong. Force-refresh conflicting PRs once when the panel sees
        // them so we don't keep rendering cached branch summaries or empty file
        // lists from an older payload.
        conflictSummaryRefreshKeyRef.current = refreshKey;
        void fetchPRForBranch(repo.path, branch, { force: true });
    }, [repo, isFolder, branch, pr, fetchPRForBranch]);
    // Fetch checks via cached store method
    const fetchChecks = useCallback(async ({ force = false, prNumberOverride } = {}) => {
        const targetPRNumber = prNumberOverride ?? prNumber;
        if (!repo || !targetPRNumber) {
            return;
        }
        setChecksLoading(true);
        try {
            const result = await fetchPRChecks(repo.path, targetPRNumber, branch, pr?.headSha, {
                force
            });
            setChecks(result);
            // Exponential backoff: if checks haven't changed, double the interval (cap 120s).
            // If they changed, reset to 30s.
            const signature = JSON.stringify(result.map((c) => `${c.name}:${c.status}:${c.conclusion}`));
            pollIntervalRef.current =
                signature === prevChecksRef.current
                    ? Math.min(pollIntervalRef.current * 2, 120_000)
                    : 30_000;
            prevChecksRef.current = signature;
        }
        catch (err) {
            console.warn('Failed to fetch PR checks:', err);
            setChecks([]);
        }
        finally {
            setChecksLoading(false);
        }
    }, [repo, prNumber, branch, pr?.headSha, fetchPRChecks]);
    // Fetch checks on mount + poll with exponential backoff
    useEffect(() => {
        if (!prNumber || !isPanelVisible) {
            setChecks([]);
            return;
        }
        // Reset backoff state on PR change
        pollIntervalRef.current = 30_000;
        prevChecksRef.current = '';
        let cancelled = false;
        void fetchChecks();
        const schedulePoll = () => {
            pollRef.current = setTimeout(() => {
                void fetchChecks().then(() => {
                    if (!cancelled) {
                        schedulePoll();
                    }
                });
            }, pollIntervalRef.current);
        };
        schedulePoll();
        return () => {
            cancelled = true;
            if (pollRef.current) {
                clearTimeout(pollRef.current);
            }
        };
    }, [fetchChecks, isPanelVisible, prNumber]);
    // Fetch comments once when PR changes (no polling — comments change infrequently).
    // The manual refresh path calls this directly; the auto-fetch effect below uses
    // its own cancellation guard to discard stale responses after PR switches.
    const fetchComments = useCallback(async ({ force = false, prNumberOverride } = {}) => {
        const targetPRNumber = prNumberOverride ?? prNumber;
        if (!repo || !targetPRNumber) {
            return;
        }
        setCommentsLoading(true);
        try {
            const result = await fetchPRComments(repo.path, targetPRNumber, { force });
            setComments(result);
        }
        catch (err) {
            console.warn('Failed to fetch PR comments:', err);
            setComments([]);
        }
        finally {
            setCommentsLoading(false);
        }
    }, [repo, prNumber, fetchPRComments]);
    useEffect(() => {
        if (!repo || !prNumber || !isPanelVisible) {
            setComments([]);
            return;
        }
        // Why: without this guard a slow response from a previous PR can overwrite
        // state after the user switches worktrees, showing the wrong PR's comments.
        let cancelled = false;
        setCommentsLoading(true);
        void fetchPRComments(repo.path, prNumber).then((result) => {
            if (!cancelled) {
                setComments(result);
                setCommentsLoading(false);
            }
        }, () => {
            if (!cancelled) {
                setComments([]);
                setCommentsLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [repo, prNumber, isPanelVisible, fetchPRComments]);
    const handleRefresh = useCallback(async () => {
        if (!repo || !branch) {
            return;
        }
        setIsRefreshing(true);
        try {
            const refreshedPR = await fetchPRForBranch(repo.path, branch, { force: true });
            if (refreshedPR) {
                await Promise.all([
                    fetchChecks({ force: true, prNumberOverride: refreshedPR.number }),
                    fetchComments({ force: true, prNumberOverride: refreshedPR.number })
                ]);
            }
            else {
                setChecks([]);
                setComments([]);
            }
        }
        finally {
            setIsRefreshing(false);
        }
    }, [repo, branch, fetchPRForBranch, fetchChecks, fetchComments]);
    const handleStartEdit = useCallback(() => {
        if (!pr) {
            return;
        }
        setTitleDraft(pr.title);
        setEditingTitle(true);
        setTimeout(() => titleInputRef.current?.focus(), 0);
    }, [pr]);
    const handleCancelEdit = useCallback(() => {
        setEditingTitle(false);
        setTitleDraft('');
    }, []);
    const handleSaveTitle = useCallback(async () => {
        if (!repo || !pr || !titleDraft.trim() || titleDraft === pr.title) {
            setEditingTitle(false);
            return;
        }
        setTitleSaving(true);
        try {
            const ok = await window.api.gh.updatePRTitle({
                repoPath: repo.path,
                prNumber: pr.number,
                title: titleDraft.trim()
            });
            if (ok) {
                // Re-fetch PR to get updated title
                await fetchPRForBranch(repo.path, branch, { force: true });
            }
        }
        finally {
            setTitleSaving(false);
            setEditingTitle(false);
        }
    }, [repo, pr, titleDraft, branch, fetchPRForBranch]);
    const handleTitleKeyDown = useCallback((e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void handleSaveTitle();
        }
        else if (e.key === 'Escape') {
            handleCancelEdit();
        }
    }, [handleSaveTitle, handleCancelEdit]);
    const handleResolve = useCallback((threadId, resolve) => {
        if (!repo || !prNumber) {
            return;
        }
        void resolveReviewThread(repo.path, prNumber, threadId, resolve).then((ok) => {
            if (ok) {
                // Update local state to match the optimistic store update
                setComments((prev) => prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c)));
            }
        });
    }, [repo, prNumber, resolveReviewThread]);
    // Refresh PR (passed to PRActions)
    const handleRefreshPR = useCallback(async () => {
        if (repo && branch) {
            await fetchPRForBranch(repo.path, branch, { force: true });
        }
    }, [repo, branch, fetchPRForBranch]);
    // Open PR in browser
    const handleOpenPR = useCallback(() => {
        if (pr?.url) {
            window.api.shell.openUrl(pr.url);
        }
    }, [pr]);
    // ── Empty state ──
    if (!worktree) {
        return (_jsxs("div", { className: "px-4 py-6", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: "No worktree selected" }), _jsx("div", { className: "mt-1 text-xs text-muted-foreground", children: "Select a worktree to view PR checks" })] }));
    }
    if (isFolder) {
        return (_jsxs("div", { className: "px-4 py-6", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: "Checks unavailable" }), _jsx("div", { className: "mt-1 text-xs text-muted-foreground", children: "Checks require a Git branch and pull request context" })] }));
    }
    if (!pr) {
        // Why: during a rebase/merge/cherry-pick the worktree is on a detached
        // HEAD, so there is no branch to look up a PR for. Showing "No pull
        // request found" is misleading — the PR still exists on the original
        // branch. Show an operation-aware message instead.
        const operationInProgress = conflictOperation !== 'unknown';
        const operationLabel = conflictOperation === 'rebase'
            ? 'Rebase'
            : conflictOperation === 'merge'
                ? 'Merge'
                : conflictOperation === 'cherry-pick'
                    ? 'Cherry-pick'
                    : null;
        return (_jsxs("div", { className: "px-4 py-6", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: operationInProgress ? `${operationLabel} in progress` : 'No pull request found' }), _jsx("div", { className: "mt-1 text-xs text-muted-foreground", children: operationInProgress
                        ? 'PR checks will be available after the operation completes'
                        : 'Push your branch and open a PR to see checks here' }), !operationInProgress && (_jsx("button", { className: "mt-3 px-3 py-1 text-xs font-medium rounded-md border border-border bg-accent/50 text-foreground hover:bg-accent transition-colors disabled:opacity-50", disabled: emptyRefreshing, onClick: () => {
                        if (!activeWorktreeId) {
                            return;
                        }
                        setEmptyRefreshing(true);
                        void handleRefresh().finally(() => {
                            setEmptyRefreshing(false);
                        });
                    }, children: emptyRefreshing ? 'Refreshing…' : 'Refresh' }))] }));
    }
    return (_jsxs("div", { className: "flex-1 overflow-auto scrollbar-sleek", children: [_jsxs("div", { className: "px-3 py-3 border-b border-border space-y-2.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(PullRequestIcon, { className: "size-4 text-muted-foreground shrink-0" }), _jsxs("span", { className: "text-[12px] font-semibold text-foreground", children: ["#", pr.number] }), _jsx("span", { className: cn('text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border', prStateColor(pr.state)), children: pr.state }), _jsx("div", { className: "flex-1" }), _jsx("button", { className: "p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors", title: "Refresh", onClick: () => void handleRefresh(), disabled: isRefreshing, children: _jsx(RefreshCw, { className: cn('size-3.5', isRefreshing && 'animate-spin') }) }), _jsx("button", { className: "p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors", title: "Open on GitHub", onClick: handleOpenPR, children: _jsx(ExternalLink, { className: "size-3.5" }) })] }), editingTitle ? (_jsxs("div", { className: "flex items-center gap-1", children: [_jsx("input", { ref: titleInputRef, className: "flex-1 text-[12px] bg-background border border-border rounded px-2 py-1 text-foreground outline-none focus:ring-1 focus:ring-ring", value: titleDraft, onChange: (e) => setTitleDraft(e.target.value), onKeyDown: handleTitleKeyDown, disabled: titleSaving }), _jsx("button", { className: "p-1 rounded hover:bg-accent text-emerald-500 hover:text-emerald-400 transition-colors", title: "Save", onClick: () => void handleSaveTitle(), disabled: titleSaving, children: titleSaving ? (_jsx(LoaderCircle, { className: "size-3.5 animate-spin" })) : (_jsx(Check, { className: "size-3.5" })) }), _jsx("button", { className: "p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors", title: "Cancel", onClick: handleCancelEdit, disabled: titleSaving, children: _jsx(X, { className: "size-3.5" }) })] })) : (_jsxs("div", { className: "group/title flex items-start gap-1.5 cursor-pointer -mx-1 px-1 py-0.5 rounded hover:bg-accent/40 transition-colors", onClick: handleStartEdit, children: [_jsx("span", { className: "text-[12px] text-foreground leading-snug flex-1", children: pr.title }), _jsx(Pencil, { className: "size-3 text-muted-foreground/40 opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0 mt-0.5" })] })), pr.updatedAt && (_jsxs("div", { className: "text-[10px] text-muted-foreground/60", children: ["Updated ", new Date(pr.updatedAt).toLocaleString()] })), worktree && repo && (_jsx(PRActions, { pr: pr, repo: repo, worktree: worktree, onRefreshPR: handleRefreshPR }))] }), _jsx(ConflictingFilesSection, { pr: pr }), _jsx(MergeConflictNotice, { pr: pr }), !(pr.mergeable === 'CONFLICTING' && checks.length === 0 && !checksLoading) && (_jsx(ChecksList, { checks: checks, checksLoading: checksLoading })), _jsx(PRCommentsList, { comments: comments, commentsLoading: commentsLoading, onResolve: handleResolve })] }));
}
