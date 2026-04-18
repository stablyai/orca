import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Minus, Plus, RefreshCw, Settings2, Undo2, FileEdit, FileMinus, FilePlus, FileQuestion, ArrowRightLeft, FolderOpen, GitMerge, GitPullRequestArrow, TriangleAlert, CircleCheck, Search, X } from 'lucide-react';
import { useAppStore } from '@/store';
import { detectLanguage } from '@/lib/language-detect';
import { basename, dirname, joinPath } from '@/lib/path';
import { cn } from '@/lib/utils';
import { isFolderRepo } from '../../../../shared/repo-kind';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { BulkActionBar } from './BulkActionBar';
import { useSourceControlSelection } from './useSourceControlSelection';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BaseRefPicker } from '@/components/settings/BaseRefPicker';
import { notifyEditorExternalFileChange, requestEditorSaveQuiesce } from '@/components/editor/editor-autosave';
import { getConnectionId } from '@/lib/connection-context';
import { PullRequestIcon } from './checks-helpers';
import { STATUS_COLORS, STATUS_LABELS } from './status-display';
const STATUS_ICONS = {
    modified: FileEdit,
    added: FilePlus,
    deleted: FileMinus,
    renamed: ArrowRightLeft,
    untracked: FileQuestion,
    copied: FilePlus
};
// Why: unstaged ("Changes") is listed first so that conflict files — which
// are assigned area:'unstaged' by the parser — appear above "Staged Changes".
// This keeps unresolved conflicts visible at the top of the list where the
// user won't miss them.
const SECTION_ORDER = ['unstaged', 'staged', 'untracked'];
const SECTION_LABELS = {
    staged: 'Staged Changes',
    unstaged: 'Changes',
    untracked: 'Untracked Files'
};
const BRANCH_REFRESH_INTERVAL_MS = 5000;
const CONFLICT_KIND_LABELS = {
    both_modified: 'Both modified',
    both_added: 'Both added',
    deleted_by_us: 'Deleted by us',
    deleted_by_them: 'Deleted by them',
    added_by_us: 'Added by us',
    added_by_them: 'Added by them',
    both_deleted: 'Both deleted'
};
function SourceControlInner() {
    const sourceControlRef = useRef(null);
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const rightSidebarTab = useAppStore((s) => s.rightSidebarTab);
    const repos = useAppStore((s) => s.repos);
    const worktreesByRepo = useAppStore((s) => s.worktreesByRepo);
    const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree);
    const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree);
    const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree);
    const gitBranchCompareSummaryByWorktree = useAppStore((s) => s.gitBranchCompareSummaryByWorktree);
    const prCache = useAppStore((s) => s.prCache);
    const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch);
    const updateRepo = useAppStore((s) => s.updateRepo);
    const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest);
    const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult);
    const revealInExplorer = useAppStore((s) => s.revealInExplorer);
    const trackConflictPath = useAppStore((s) => s.trackConflictPath);
    const openDiff = useAppStore((s) => s.openDiff);
    const openConflictFile = useAppStore((s) => s.openConflictFile);
    const openConflictReview = useAppStore((s) => s.openConflictReview);
    const openBranchDiff = useAppStore((s) => s.openBranchDiff);
    const openAllDiffs = useAppStore((s) => s.openAllDiffs);
    const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs);
    const [scope, setScope] = useState('all');
    const [collapsedSections, setCollapsedSections] = useState(new Set());
    const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false);
    const [defaultBaseRef, setDefaultBaseRef] = useState('origin/main');
    const [filterQuery, setFilterQuery] = useState('');
    const filterInputRef = useRef(null);
    const activeWorktree = useMemo(() => {
        if (!activeWorktreeId) {
            return null;
        }
        for (const worktrees of Object.values(worktreesByRepo)) {
            const worktree = worktrees.find((entry) => entry.id === activeWorktreeId);
            if (worktree) {
                return worktree;
            }
        }
        return null;
    }, [activeWorktreeId, worktreesByRepo]);
    const activeRepo = useMemo(() => repos.find((repo) => repo.id === activeWorktree?.repoId) ?? null, [activeWorktree?.repoId, repos]);
    const isFolder = activeRepo ? isFolderRepo(activeRepo) : false;
    const worktreePath = activeWorktree?.path ?? null;
    const entries = useMemo(() => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []), [activeWorktreeId, gitStatusByWorktree]);
    const branchEntries = useMemo(() => (activeWorktreeId ? (gitBranchChangesByWorktree[activeWorktreeId] ?? []) : []), [activeWorktreeId, gitBranchChangesByWorktree]);
    const branchSummary = activeWorktreeId
        ? (gitBranchCompareSummaryByWorktree[activeWorktreeId] ?? null)
        : null;
    const conflictOperation = activeWorktreeId
        ? (gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown')
        : 'unknown';
    const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen);
    // Why: gate polling on both the active tab AND the sidebar being open.
    // The sidebar now stays mounted when closed (for performance), so without
    // this guard the branchCompare interval and PR fetch would keep running
    // with no visible consumer, wasting git process spawns and API calls.
    const isBranchVisible = rightSidebarTab === 'source-control' && rightSidebarOpen;
    useEffect(() => {
        if (!activeRepo || isFolder) {
            return;
        }
        // Why: reset to null so that effectiveBaseRef becomes falsy until the IPC
        // resolves.  This prevents the branch compare from firing with a stale
        // defaultBaseRef left over from a *different* repo (e.g. 'origin/master'
        // when the new repo uses 'origin/main'), which would cause a transient
        // "invalid-base" error every time the user switches between repos.
        setDefaultBaseRef(null);
        let stale = false;
        void window.api.repos
            .getBaseRefDefault({ repoId: activeRepo.id })
            .then((result) => {
            if (!stale) {
                setDefaultBaseRef(result);
            }
        })
            .catch(() => {
            if (!stale) {
                setDefaultBaseRef('origin/main');
            }
        });
        return () => {
            stale = true;
        };
    }, [activeRepo, isFolder]);
    const effectiveBaseRef = activeRepo?.worktreeBaseRef ?? defaultBaseRef;
    const hasUncommittedEntries = entries.length > 0;
    const branchName = activeWorktree?.branch.replace(/^refs\/heads\//, '') ?? 'HEAD';
    const prCacheKey = activeRepo && branchName ? `${activeRepo.path}::${branchName}` : null;
    const prInfo = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null;
    useEffect(() => {
        if (!isBranchVisible || !activeRepo || isFolder || !branchName || branchName === 'HEAD') {
            return;
        }
        // Why: the Source Control panel renders the branch's PR badge directly.
        // When a terminal checkout moves this worktree onto a new branch, we need
        // to fetch that branch's PR immediately instead of waiting for the user to
        // reselect the worktree or open the separate Checks panel.
        void fetchPRForBranch(activeRepo.path, branchName);
    }, [activeRepo, branchName, fetchPRForBranch, isBranchVisible, isFolder]);
    const grouped = useMemo(() => {
        const groups = {
            staged: [],
            unstaged: [],
            untracked: []
        };
        for (const entry of entries) {
            groups[entry.area].push(entry);
        }
        for (const area of SECTION_ORDER) {
            groups[area].sort(compareGitStatusEntries);
        }
        return groups;
    }, [entries]);
    const normalizedFilter = filterQuery.toLowerCase();
    const filteredGrouped = useMemo(() => {
        if (!normalizedFilter) {
            return grouped;
        }
        return {
            staged: grouped.staged.filter((e) => e.path.toLowerCase().includes(normalizedFilter)),
            unstaged: grouped.unstaged.filter((e) => e.path.toLowerCase().includes(normalizedFilter)),
            untracked: grouped.untracked.filter((e) => e.path.toLowerCase().includes(normalizedFilter))
        };
    }, [grouped, normalizedFilter]);
    const filteredBranchEntries = useMemo(() => {
        if (!normalizedFilter) {
            return branchEntries;
        }
        return branchEntries.filter((e) => e.path.toLowerCase().includes(normalizedFilter));
    }, [branchEntries, normalizedFilter]);
    const flatEntries = useMemo(() => {
        const arr = [];
        for (const area of SECTION_ORDER) {
            if (!collapsedSections.has(area)) {
                for (const entry of filteredGrouped[area]) {
                    arr.push({ key: `${area}::${entry.path}`, entry, area });
                }
            }
        }
        return arr;
    }, [filteredGrouped, collapsedSections]);
    const [isExecutingBulk, setIsExecutingBulk] = useState(false);
    // Why: the sidebar no longer uses key={activeWorktreeId} to force a full
    // remount on worktree switch (that caused an IPC storm on Windows).
    // Instead, reset worktree-specific local state here so the previous
    // worktree's UI state doesn't leak into the new one.
    useEffect(() => {
        setScope('all');
        setCollapsedSections(new Set());
        setBaseRefDialogOpen(false);
        setDefaultBaseRef('origin/main');
        setFilterQuery('');
        setIsExecutingBulk(false);
    }, [activeWorktreeId]);
    const handleOpenDiff = useCallback((entry) => {
        if (!activeWorktreeId || !worktreePath) {
            return;
        }
        if (entry.conflictKind && entry.conflictStatus) {
            if (entry.conflictStatus === 'unresolved') {
                trackConflictPath(activeWorktreeId, entry.path, entry.conflictKind);
            }
            openConflictFile(activeWorktreeId, worktreePath, entry, detectLanguage(entry.path));
            return;
        }
        openDiff(activeWorktreeId, joinPath(worktreePath, entry.path), entry.path, detectLanguage(entry.path), entry.area === 'staged');
    }, [activeWorktreeId, worktreePath, trackConflictPath, openConflictFile, openDiff]);
    const { selectedKeys, handleSelect, handleContextMenu, clearSelection } = useSourceControlSelection({
        flatEntries,
        onOpenDiff: handleOpenDiff,
        containerRef: sourceControlRef
    });
    // clear selection on scope change
    useEffect(() => {
        clearSelection();
    }, [scope, clearSelection]);
    // Clear selection on worktree or tab change
    useEffect(() => {
        clearSelection();
    }, [activeWorktreeId, rightSidebarTab, clearSelection]);
    const flatEntriesByKey = useMemo(() => new Map(flatEntries.map((entry) => [entry.key, entry])), [flatEntries]);
    const selectedEntries = useMemo(() => Array.from(selectedKeys)
        .map((key) => flatEntriesByKey.get(key))
        .filter((entry) => Boolean(entry)), [selectedKeys, flatEntriesByKey]);
    const bulkStagePaths = useMemo(() => selectedEntries
        .filter((entry) => (entry.area === 'unstaged' || entry.area === 'untracked') &&
        entry.entry.conflictStatus !== 'unresolved')
        .map((entry) => entry.entry.path), [selectedEntries]);
    const bulkUnstagePaths = useMemo(() => selectedEntries.filter((entry) => entry.area === 'staged').map((entry) => entry.entry.path), [selectedEntries]);
    const selectedKeySet = selectedKeys;
    const handleBulkStage = useCallback(async () => {
        if (!worktreePath || bulkStagePaths.length === 0) {
            return;
        }
        setIsExecutingBulk(true);
        try {
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            await window.api.git.bulkStage({ worktreePath, filePaths: bulkStagePaths, connectionId });
            clearSelection();
        }
        finally {
            setIsExecutingBulk(false);
        }
    }, [worktreePath, bulkStagePaths, clearSelection, activeWorktreeId]);
    const handleBulkUnstage = useCallback(async () => {
        if (!worktreePath || bulkUnstagePaths.length === 0) {
            return;
        }
        setIsExecutingBulk(true);
        try {
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            await window.api.git.bulkUnstage({ worktreePath, filePaths: bulkUnstagePaths, connectionId });
            clearSelection();
        }
        finally {
            setIsExecutingBulk(false);
        }
    }, [worktreePath, bulkUnstagePaths, clearSelection, activeWorktreeId]);
    const unresolvedConflicts = useMemo(() => entries.filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind), [entries]);
    const unresolvedConflictReviewEntries = useMemo(() => unresolvedConflicts.map((entry) => ({
        path: entry.path,
        conflictKind: entry.conflictKind
    })), [unresolvedConflicts]);
    const refreshBranchCompare = useCallback(async () => {
        if (!activeWorktreeId || !worktreePath || !effectiveBaseRef || isFolder) {
            return;
        }
        const requestKey = `${activeWorktreeId}:${effectiveBaseRef}:${Date.now()}`;
        const existingSummary = useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId];
        // Why: only show the loading spinner for the very first branch compare
        // request, or when the base ref has changed (user picked a new one, or
        // getBaseRefDefault corrected a stale cross-repo value).  Polling retries
        // — whether the previous result was 'ready' *or* an error — keep the
        // current UI visible until the new IPC result arrives.  Resetting to
        // 'loading' on every 5-second poll when the compare is in an error state
        // caused a visible loading→error→loading→error flicker.
        const baseRefChanged = existingSummary && existingSummary.baseRef !== effectiveBaseRef;
        const shouldResetToLoading = !existingSummary || baseRefChanged;
        if (shouldResetToLoading) {
            beginGitBranchCompareRequest(activeWorktreeId, requestKey, effectiveBaseRef);
        }
        else {
            useAppStore.setState((s) => ({
                gitBranchCompareRequestKeyByWorktree: {
                    ...s.gitBranchCompareRequestKeyByWorktree,
                    [activeWorktreeId]: requestKey
                }
            }));
        }
        try {
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            const result = await window.api.git.branchCompare({
                worktreePath,
                baseRef: effectiveBaseRef,
                connectionId
            });
            setGitBranchCompareResult(activeWorktreeId, requestKey, result);
        }
        catch (error) {
            setGitBranchCompareResult(activeWorktreeId, requestKey, {
                summary: {
                    baseRef: effectiveBaseRef,
                    baseOid: null,
                    compareRef: branchName,
                    headOid: null,
                    mergeBase: null,
                    changedFiles: 0,
                    status: 'error',
                    errorMessage: error instanceof Error ? error.message : 'Branch compare failed'
                },
                entries: []
            });
        }
    }, [
        activeWorktreeId,
        beginGitBranchCompareRequest,
        branchName,
        effectiveBaseRef,
        isFolder,
        setGitBranchCompareResult,
        worktreePath
    ]);
    const refreshBranchCompareRef = useRef(refreshBranchCompare);
    refreshBranchCompareRef.current = refreshBranchCompare;
    useEffect(() => {
        if (!activeWorktreeId || !worktreePath || !isBranchVisible || !effectiveBaseRef || isFolder) {
            return;
        }
        void refreshBranchCompareRef.current();
        const intervalId = window.setInterval(() => void refreshBranchCompareRef.current(), BRANCH_REFRESH_INTERVAL_MS);
        return () => window.clearInterval(intervalId);
    }, [activeWorktreeId, effectiveBaseRef, isBranchVisible, isFolder, worktreePath]);
    const toggleSection = useCallback((section) => {
        setCollapsedSections((prev) => {
            const next = new Set(prev);
            if (next.has(section)) {
                next.delete(section);
            }
            else {
                next.add(section);
            }
            return next;
        });
    }, []);
    const openCommittedDiff = useCallback((entry) => {
        if (!activeWorktreeId ||
            !worktreePath ||
            !branchSummary ||
            branchSummary.status !== 'ready') {
            return;
        }
        openBranchDiff(activeWorktreeId, worktreePath, entry, branchSummary, detectLanguage(entry.path));
    }, [activeWorktreeId, branchSummary, openBranchDiff, worktreePath]);
    const handleStage = useCallback(async (filePath) => {
        if (!worktreePath) {
            return;
        }
        try {
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            await window.api.git.stage({ worktreePath, filePath, connectionId });
        }
        catch {
            // git operation failed silently
        }
    }, [worktreePath, activeWorktreeId]);
    const handleUnstage = useCallback(async (filePath) => {
        if (!worktreePath) {
            return;
        }
        try {
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            await window.api.git.unstage({ worktreePath, filePath, connectionId });
        }
        catch {
            // git operation failed silently
        }
    }, [worktreePath, activeWorktreeId]);
    const handleDiscard = useCallback(async (filePath) => {
        if (!worktreePath || !activeWorktreeId) {
            return;
        }
        try {
            // Why: git discard replaces the working tree version of this file. Any
            // pending editor autosave must be quiesced first so it cannot recreate
            // the discarded edits after git restores the file.
            await requestEditorSaveQuiesce({
                worktreeId: activeWorktreeId,
                worktreePath,
                relativePath: filePath
            });
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            await window.api.git.discard({ worktreePath, filePath, connectionId });
            notifyEditorExternalFileChange({
                worktreeId: activeWorktreeId,
                worktreePath,
                relativePath: filePath
            });
        }
        catch {
            // git operation failed silently
        }
    }, [activeWorktreeId, worktreePath]);
    if (!activeWorktree || !activeRepo || !worktreePath) {
        return (_jsx("div", { className: "flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center", children: "Select a worktree to view changes" }));
    }
    if (isFolder) {
        return (_jsx("div", { className: "flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center", children: "Source Control is only available for Git repositories" }));
    }
    const hasFilteredUncommittedEntries = filteredGrouped.staged.length > 0 ||
        filteredGrouped.unstaged.length > 0 ||
        filteredGrouped.untracked.length > 0;
    const hasFilteredBranchEntries = filteredBranchEntries.length > 0;
    const showGenericEmptyState = !hasUncommittedEntries && branchSummary?.status === 'ready' && branchEntries.length === 0;
    const currentWorktreeId = activeWorktree.id;
    return (_jsxs(_Fragment, { children: [_jsxs("div", { ref: sourceControlRef, className: "relative flex h-full flex-col overflow-hidden", children: [_jsxs("div", { className: "flex items-center px-3 pt-2 border-b border-border", children: [['all', 'uncommitted'].map((value) => (_jsx("button", { type: "button", className: cn('px-3 pb-2 text-xs font-medium transition-colors border-b-2 -mb-px', scope === value
                                    ? 'border-foreground text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'), onClick: () => setScope(value), children: value === 'all' ? 'All' : 'Uncommitted' }, value))), prInfo && (_jsxs("div", { className: "ml-auto mb-1.5 flex items-center gap-1.5 min-w-0 text-[11.5px] leading-none", children: [_jsx(PullRequestIcon, { className: cn('size-3 shrink-0', prInfo.state === 'merged' && 'text-purple-500/80', prInfo.state === 'open' && 'text-emerald-500/80', prInfo.state === 'closed' && 'text-muted-foreground/60', prInfo.state === 'draft' && 'text-muted-foreground/50') }), _jsxs("a", { href: prInfo.url, target: "_blank", rel: "noreferrer", className: "text-foreground opacity-80 font-medium shrink-0 hover:text-foreground hover:underline", onClick: (e) => e.stopPropagation(), children: ["PR #", prInfo.number] })] }))] }), scope === 'all' && (_jsx("div", { className: "border-b border-border px-3 py-2", children: _jsx(CompareSummary, { summary: branchSummary, onChangeBaseRef: () => setBaseRefDialogOpen(true), onRetry: () => void refreshBranchCompare() }) })), _jsxs("div", { className: "flex items-center gap-1.5 border-b border-border px-3 py-1.5", children: [_jsx(Search, { className: "size-3.5 shrink-0 text-muted-foreground" }), _jsx("input", { ref: filterInputRef, type: "text", value: filterQuery, onChange: (e) => setFilterQuery(e.target.value), placeholder: "Filter files\u2026", className: "flex-1 min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none" }), filterQuery && (_jsx("button", { type: "button", className: "shrink-0 text-muted-foreground hover:text-foreground", onClick: () => {
                                    setFilterQuery('');
                                    filterInputRef.current?.focus();
                                }, children: _jsx(X, { className: "size-3.5" }) }))] }), _jsxs("div", { className: "relative flex-1 overflow-auto scrollbar-sleek py-1", style: { paddingBottom: selectedKeys.size > 0 ? 50 : undefined }, children: [unresolvedConflictReviewEntries.length > 0 && (_jsx("div", { className: "px-3 pb-2", children: _jsx(ConflictSummaryCard, { conflictOperation: conflictOperation, unresolvedCount: unresolvedConflictReviewEntries.length, onReview: () => {
                                        if (!activeWorktreeId || !worktreePath) {
                                            return;
                                        }
                                        openConflictReview(activeWorktreeId, worktreePath, unresolvedConflictReviewEntries, 'live-summary');
                                    } }) })), unresolvedConflictReviewEntries.length === 0 && conflictOperation !== 'unknown' && (_jsx("div", { className: "px-3 pb-2", children: _jsx(OperationBanner, { conflictOperation: conflictOperation }) })), scope === 'all' && showGenericEmptyState && !normalizedFilter ? (_jsx(EmptyState, { heading: "No changes on this branch", supportingText: `This worktree is clean and this branch has no changes ahead of ${branchSummary.baseRef}` })) : null, scope === 'uncommitted' && !hasUncommittedEntries && !normalizedFilter && (_jsx(EmptyState, { heading: "No uncommitted changes", supportingText: "All changes have been committed" })), normalizedFilter &&
                                !hasFilteredUncommittedEntries &&
                                (scope === 'uncommitted' || !hasFilteredBranchEntries) && (_jsx(EmptyState, { heading: "No matching files", supportingText: `No changed files match "${filterQuery}"` })), (scope === 'all' || scope === 'uncommitted') && hasFilteredUncommittedEntries && (_jsx(_Fragment, { children: SECTION_ORDER.map((area) => {
                                    const items = filteredGrouped[area];
                                    if (items.length === 0) {
                                        return null;
                                    }
                                    const isCollapsed = collapsedSections.has(area);
                                    return (_jsxs("div", { children: [_jsx(SectionHeader, { label: SECTION_LABELS[area], count: items.length, conflictCount: items.filter((entry) => entry.conflictStatus === 'unresolved').length, isCollapsed: isCollapsed, onToggle: () => toggleSection(area), actions: items.some((entry) => entry.conflictStatus === 'unresolved') ? (_jsx(Button, { type: "button", variant: "ghost", size: "sm", className: "h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground", onClick: (e) => {
                                                        e.stopPropagation();
                                                        if (activeWorktreeId && worktreePath) {
                                                            openAllDiffs(activeWorktreeId, worktreePath, undefined, area);
                                                        }
                                                    }, children: "View all" })) : (_jsx(Button, { type: "button", variant: "ghost", size: "sm", className: "h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground", onClick: (e) => {
                                                        e.stopPropagation();
                                                        if (activeWorktreeId && worktreePath) {
                                                            openAllDiffs(activeWorktreeId, worktreePath, undefined, area);
                                                        }
                                                    }, children: "View all" })) }), !isCollapsed &&
                                                items.map((entry) => {
                                                    const key = `${entry.area}::${entry.path}`;
                                                    return (_jsx(UncommittedEntryRow, { entryKey: key, entry: entry, currentWorktreeId: currentWorktreeId, worktreePath: worktreePath, selected: selectedKeySet.has(key), onSelect: handleSelect, onContextMenu: handleContextMenu, onRevealInExplorer: revealInExplorer, onOpen: handleOpenDiff, onStage: handleStage, onUnstage: handleUnstage, onDiscard: handleDiscard }, key));
                                                })] }, area));
                                }) })), scope === 'all' &&
                                branchSummary &&
                                branchSummary.status !== 'ready' &&
                                branchSummary.status !== 'loading' ? (_jsx(CompareUnavailable, { summary: branchSummary, onChangeBaseRef: () => setBaseRefDialogOpen(true), onRetry: () => void refreshBranchCompare() })) : null, scope === 'all' && branchSummary?.status === 'ready' && hasFilteredBranchEntries && (_jsxs("div", { children: [_jsx(SectionHeader, { label: "Committed on Branch", count: filteredBranchEntries.length, isCollapsed: collapsedSections.has('branch'), onToggle: () => toggleSection('branch'), actions: _jsx(Button, { type: "button", variant: "ghost", size: "sm", className: "h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground", onClick: (e) => {
                                                e.stopPropagation();
                                                if (activeWorktreeId && worktreePath && branchSummary) {
                                                    openBranchAllDiffs(activeWorktreeId, worktreePath, branchSummary);
                                                }
                                            }, children: "View all" }) }), !collapsedSections.has('branch') &&
                                        filteredBranchEntries.map((entry) => (_jsx(BranchEntryRow, { entry: entry, currentWorktreeId: currentWorktreeId, worktreePath: worktreePath, onRevealInExplorer: revealInExplorer, onOpen: () => openCommittedDiff(entry) }, `branch:${entry.path}`)))] }))] }), selectedKeys.size > 0 && (_jsx(BulkActionBar, { selectedCount: selectedKeys.size, stageableCount: bulkStagePaths.length, unstageableCount: bulkUnstagePaths.length, onStage: handleBulkStage, onUnstage: handleBulkUnstage, onClear: clearSelection, isExecuting: isExecutingBulk }))] }), _jsx(Dialog, { open: baseRefDialogOpen, onOpenChange: setBaseRefDialogOpen, children: _jsxs(DialogContent, { className: "max-w-xl", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Change Base Ref" }), _jsx(DialogDescription, { className: "text-xs", children: "Pick the branch compare target for this repository." })] }), _jsx(BaseRefPicker, { repoId: activeRepo.id, currentBaseRef: activeRepo.worktreeBaseRef, onSelect: (ref) => {
                                void updateRepo(activeRepo.id, { worktreeBaseRef: ref });
                                setBaseRefDialogOpen(false);
                                window.setTimeout(() => void refreshBranchCompare(), 0);
                            }, onUsePrimary: () => {
                                void updateRepo(activeRepo.id, { worktreeBaseRef: undefined });
                                setBaseRefDialogOpen(false);
                                window.setTimeout(() => void refreshBranchCompare(), 0);
                            } })] }) })] }));
}
const SourceControl = React.memo(SourceControlInner);
export default SourceControl;
function CompareSummary({ summary, onChangeBaseRef, onRetry }) {
    if (!summary || summary.status === 'loading') {
        return (_jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [_jsx(RefreshCw, { className: "size-3.5 animate-spin" }), _jsxs("span", { children: ["Comparing against ", summary?.baseRef ?? '…'] })] }));
    }
    if (summary.status !== 'ready') {
        return (_jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [_jsx("span", { className: "truncate", children: summary.errorMessage ?? 'Branch compare unavailable' }), _jsx("button", { className: "shrink-0 hover:text-foreground", onClick: onChangeBaseRef, title: "Change base ref", children: _jsx(Settings2, { className: "size-3.5" }) }), _jsx("button", { className: "shrink-0 hover:text-foreground", onClick: onRetry, title: "Retry", children: _jsx(RefreshCw, { className: "size-3.5" }) })] }));
    }
    return (_jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [summary.commitsAhead !== undefined && (_jsxs("span", { title: `Comparing against ${summary.baseRef}`, children: [summary.commitsAhead, " commits ahead"] })), _jsx(TooltipProvider, { delayDuration: 400, children: _jsxs("div", { className: "ml-auto flex items-center gap-2 shrink-0", children: [_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { className: "hover:text-foreground p-0.5 rounded", onClick: onChangeBaseRef, children: _jsx(Settings2, { className: "size-3.5" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Change base ref" })] }), _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { className: "hover:text-foreground p-0.5 rounded", onClick: onRetry, children: _jsx(RefreshCw, { className: "size-3.5" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Refresh branch compare" })] })] }) })] }));
}
function CompareUnavailable({ summary, onChangeBaseRef, onRetry }) {
    const changeBaseRefAllowed = summary.status === 'invalid-base' ||
        summary.status === 'no-merge-base' ||
        summary.status === 'error';
    return (_jsxs("div", { className: "m-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-xs", children: [_jsx("div", { className: "font-medium text-foreground", children: summary.status === 'error' ? 'Branch compare failed' : 'Branch compare unavailable' }), _jsx("div", { className: "mt-1 text-muted-foreground", children: summary.errorMessage ?? 'Unable to load branch compare.' }), _jsxs("div", { className: "mt-3 flex items-center gap-2", children: [changeBaseRefAllowed && (_jsxs(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 text-xs", onClick: onChangeBaseRef, children: [_jsx(Settings2, { className: "size-3.5" }), "Change Base Ref"] })), _jsxs(Button, { type: "button", variant: "ghost", size: "sm", className: "h-7 text-xs", onClick: onRetry, children: [_jsx(RefreshCw, { className: "size-3.5" }), "Retry"] })] })] }));
}
function SectionHeader({ label, count, conflictCount = 0, isCollapsed, onToggle, actions }) {
    return (_jsxs("div", { className: "group/section flex items-center pl-1 pr-3 pt-3 pb-1", children: [_jsxs("button", { type: "button", className: "flex flex-1 items-center gap-1 rounded-md px-0.5 py-0.5 text-left text-xs font-semibold uppercase tracking-wider text-foreground/70 hover:bg-accent hover:text-accent-foreground", onClick: onToggle, children: [_jsx(ChevronDown, { className: cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90') }), _jsx("span", { children: label }), _jsx("span", { className: "text-[11px] font-medium tabular-nums", children: count }), conflictCount > 0 && (_jsxs("span", { className: "text-[11px] font-medium text-destructive/80", children: ["\u00B7 ", conflictCount, " conflict", conflictCount === 1 ? '' : 's'] }))] }), _jsx("div", { className: "shrink-0 flex items-center", children: actions })] }));
}
function ConflictSummaryCard({ conflictOperation, unresolvedCount, onReview }) {
    const operationLabel = conflictOperation === 'merge'
        ? 'Merge conflicts'
        : conflictOperation === 'rebase'
            ? 'Rebase conflicts'
            : conflictOperation === 'cherry-pick'
                ? 'Cherry-pick conflicts'
                : 'Conflicts';
    return (_jsxs("div", { className: "rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2", children: [_jsxs("div", { className: "flex items-start gap-2", children: [_jsx(TriangleAlert, { className: "mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "text-xs font-medium text-foreground", "aria-live": "polite", children: `${operationLabel}: ${unresolvedCount} unresolved` }), _jsx("div", { className: "mt-1 text-[11px] text-muted-foreground", children: "Resolved files move back to normal changes after they leave the live conflict state." })] })] }), _jsx("div", { className: "mt-2", children: _jsxs(Button, { type: "button", variant: "outline", size: "sm", className: "h-7 text-xs w-full", onClick: onReview, children: [_jsx(GitMerge, { className: "size-3.5" }), "Review conflicts"] }) })] }));
}
// Why: this banner is separate from ConflictSummaryCard because a rebase (or
// merge/cherry-pick) can be in progress without any conflicts — e.g. between
// rebase steps, or after resolving all conflicts but before --continue. The
// user needs to see the operation state so they know the worktree is mid-rebase
// and that they should run `git rebase --continue` or `--abort`.
function OperationBanner({ conflictOperation }) {
    const label = conflictOperation === 'merge'
        ? 'Merge in progress'
        : conflictOperation === 'rebase'
            ? 'Rebase in progress'
            : conflictOperation === 'cherry-pick'
                ? 'Cherry-pick in progress'
                : 'Operation in progress';
    const Icon = conflictOperation === 'rebase' ? GitPullRequestArrow : GitMerge;
    return (_jsx("div", { className: "rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Icon, { className: "size-4 shrink-0 text-amber-600 dark:text-amber-400" }), _jsx("span", { className: "text-xs font-medium text-foreground", children: label })] }) }));
}
const UncommittedEntryRow = React.memo(function UncommittedEntryRow({ entryKey, entry, currentWorktreeId, worktreePath, selected, onSelect, onContextMenu, onRevealInExplorer, onOpen, onStage, onUnstage, onDiscard }) {
    const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion;
    const fileName = basename(entry.path);
    const parentDir = dirname(entry.path);
    const dirPath = parentDir === '.' ? '' : parentDir;
    const isUnresolvedConflict = entry.conflictStatus === 'unresolved';
    const isResolvedLocally = entry.conflictStatus === 'resolved_locally';
    const conflictLabel = entry.conflictKind ? CONFLICT_KIND_LABELS[entry.conflictKind] : null;
    // Why: the hint text ("Open and edit…", "Decide whether to…") was removed
    // from the sidebar because it's not actionable here — the user can only
    // click the row, and the conflict-kind label alone is sufficient context.
    // Why: Stage is suppressed for unresolved conflicts because `git add` would
    // immediately erase the `u` record — the only live conflict signal in the
    // sidebar — before the user has actually reviewed the file. The user should
    // resolve in the editor first, then stage from the post-resolution state.
    //
    // Discard is hidden for both unresolved AND resolved_locally rows in v1.
    // For unresolved: discarding is too easy to misfire on a high-risk file.
    // For resolved_locally: discarding can silently re-create the conflict or
    // lose the resolution, and v1 does not have UX to explain this clearly.
    const canDiscard = !isUnresolvedConflict &&
        !isResolvedLocally &&
        (entry.area === 'unstaged' || entry.area === 'untracked');
    const canStage = !isUnresolvedConflict && (entry.area === 'unstaged' || entry.area === 'untracked');
    const canUnstage = entry.area === 'staged';
    return (_jsx(SourceControlEntryContextMenu, { currentWorktreeId: currentWorktreeId, absolutePath: joinPath(worktreePath, entry.path), onRevealInExplorer: onRevealInExplorer, onOpenChange: (open) => {
            if (open && onContextMenu) {
                onContextMenu(entryKey);
            }
        }, children: _jsxs("div", { className: cn('group relative flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40', selected && 'bg-accent/60'), draggable: true, onDragStart: (e) => {
                if (isUnresolvedConflict && entry.status === 'deleted') {
                    e.preventDefault();
                    return;
                }
                const absolutePath = joinPath(worktreePath, entry.path);
                e.dataTransfer.setData('text/x-orca-file-path', absolutePath);
                e.dataTransfer.effectAllowed = 'copy';
            }, onClick: (e) => {
                if (onSelect) {
                    onSelect(e, entryKey, entry);
                }
                else {
                    onOpen(entry);
                }
            }, children: [_jsx(StatusIcon, { className: "size-3.5 shrink-0", style: { color: STATUS_COLORS[entry.status] } }), _jsxs("div", { className: "min-w-0 flex-1 text-xs", children: [_jsxs("span", { className: "min-w-0 block truncate", children: [_jsx("span", { className: "text-foreground", children: fileName }), dirPath && _jsx("span", { className: "ml-1.5 text-[11px] text-muted-foreground", children: dirPath })] }), conflictLabel && (_jsx("div", { className: "truncate text-[11px] text-muted-foreground", children: conflictLabel }))] }), entry.conflictStatus ? (_jsx(ConflictBadge, { entry: entry })) : (_jsx("span", { className: "w-4 shrink-0 text-center text-[10px] font-bold", style: { color: STATUS_COLORS[entry.status] }, children: STATUS_LABELS[entry.status] })), _jsxs("div", { className: "absolute right-0 top-0 bottom-0 shrink-0 hidden group-hover:flex items-center gap-1.5 bg-accent pr-3 pl-2", children: [canDiscard && (_jsx(ActionButton, { icon: Undo2, title: entry.area === 'untracked' ? 'Revert untracked file' : 'Discard changes', onClick: (event) => {
                                event.stopPropagation();
                                void onDiscard(entry.path);
                            } })), canStage && (_jsx(ActionButton, { icon: Plus, title: "Stage", onClick: (event) => {
                                event.stopPropagation();
                                void onStage(entry.path);
                            } })), canUnstage && (_jsx(ActionButton, { icon: Minus, title: "Unstage", onClick: (event) => {
                                event.stopPropagation();
                                void onUnstage(entry.path);
                            } }))] })] }) }));
});
function ConflictBadge({ entry }) {
    const isUnresolvedConflict = entry.conflictStatus === 'unresolved';
    const label = isUnresolvedConflict ? 'Unresolved' : 'Resolved locally';
    const Icon = isUnresolvedConflict ? TriangleAlert : CircleCheck;
    const badge = (_jsxs("span", { role: "status", "aria-label": `${label} conflict${entry.conflictKind ? `, ${CONFLICT_KIND_LABELS[entry.conflictKind]}` : ''}`, className: cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', isUnresolvedConflict
            ? 'bg-destructive/12 text-destructive'
            : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'), children: [_jsx(Icon, { className: "size-3" }), _jsx("span", { children: label })] }));
    if (isUnresolvedConflict) {
        return badge;
    }
    return (_jsx(TooltipProvider, { delayDuration: 300, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: badge }), _jsx(TooltipContent, { side: "left", sideOffset: 6, children: "Local session state derived from a conflict you opened here." })] }) }));
}
function BranchEntryRow({ entry, currentWorktreeId, worktreePath, onRevealInExplorer, onOpen }) {
    const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion;
    const fileName = basename(entry.path);
    const parentDir = dirname(entry.path);
    const dirPath = parentDir === '.' ? '' : parentDir;
    return (_jsx(SourceControlEntryContextMenu, { currentWorktreeId: currentWorktreeId, absolutePath: joinPath(worktreePath, entry.path), onRevealInExplorer: onRevealInExplorer, children: _jsxs("div", { className: "group flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40", draggable: true, onDragStart: (e) => {
                const absolutePath = joinPath(worktreePath, entry.path);
                e.dataTransfer.setData('text/x-orca-file-path', absolutePath);
                e.dataTransfer.effectAllowed = 'copy';
            }, onClick: onOpen, children: [_jsx(StatusIcon, { className: "size-3.5 shrink-0", style: { color: STATUS_COLORS[entry.status] } }), _jsxs("span", { className: "min-w-0 flex-1 truncate text-xs", children: [_jsx("span", { className: "text-foreground", children: fileName }), dirPath && _jsx("span", { className: "ml-1.5 text-[11px] text-muted-foreground", children: dirPath })] }), _jsx("span", { className: "w-4 shrink-0 text-center text-[10px] font-bold", style: { color: STATUS_COLORS[entry.status] }, children: STATUS_LABELS[entry.status] })] }) }));
}
function SourceControlEntryContextMenu({ currentWorktreeId, absolutePath, onRevealInExplorer, onOpenChange, children }) {
    const handleOpenInFileExplorer = useCallback(() => {
        if (!absolutePath) {
            return;
        }
        onRevealInExplorer(currentWorktreeId, absolutePath);
    }, [absolutePath, currentWorktreeId, onRevealInExplorer]);
    return (_jsxs(ContextMenu, { onOpenChange: onOpenChange, children: [_jsx(ContextMenuTrigger, { asChild: true, children: children }), _jsx(ContextMenuContent, { className: "w-52", children: _jsxs(ContextMenuItem, { onSelect: handleOpenInFileExplorer, disabled: !absolutePath, children: [_jsx(FolderOpen, { className: "size-3.5" }), "Open in File Explorer"] }) })] }));
}
function EmptyState({ heading, supportingText }) {
    return (_jsxs("div", { className: "px-4 py-6", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: heading }), _jsx("div", { className: "mt-1 text-xs text-muted-foreground", children: supportingText })] }));
}
function ActionButton({ icon: Icon, title, onClick }) {
    return (_jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", className: "h-auto w-auto p-0.5 text-muted-foreground hover:text-foreground", title: title, onClick: onClick, children: _jsx(Icon, { className: "size-3.5" }) }));
}
function compareGitStatusEntries(a, b) {
    return (getConflictSortRank(a) - getConflictSortRank(b) ||
        a.path.localeCompare(b.path, undefined, { numeric: true }));
}
function getConflictSortRank(entry) {
    if (entry.conflictStatus === 'unresolved') {
        return 0;
    }
    if (entry.conflictStatus === 'resolved_locally') {
        return 1;
    }
    return 2;
}
