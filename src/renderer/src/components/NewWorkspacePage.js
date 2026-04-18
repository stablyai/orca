import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: the new-workspace page keeps the composer,
task source controls, and GitHub task list co-located so the wiring between the
selected repo, the draft composer, and the work-item list stays readable in one
place while this surface is still evolving. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleDot, EllipsisVertical, ExternalLink, Github, GitPullRequest, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import RepoCombobox from '@/components/repo/RepoCombobox';
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard';
import GitHubItemDrawer from '@/components/GitHubItemDrawer';
import { cn } from '@/lib/utils';
import { LightRays } from '@/components/ui/light-rays';
import { useComposerState } from '@/hooks/useComposerState';
import { getLinkedWorkItemSuggestedName, getTaskPresetQuery } from '@/lib/new-workspace';
function LinearIcon({ className }) {
    return (_jsx("svg", { viewBox: "0 0 24 24", "aria-hidden": true, className: className, fill: "currentColor", children: _jsx("path", { d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" }) }));
}
const SOURCE_OPTIONS = [
    {
        id: 'github',
        label: 'GitHub',
        Icon: ({ className }) => _jsx(Github, { className: className })
    },
    {
        id: 'linear',
        label: 'Linear',
        Icon: ({ className }) => _jsx(LinearIcon, { className: className })
    }
];
const TASK_QUERY_PRESETS = [
    { id: 'all', label: 'All', query: getTaskPresetQuery('all') },
    { id: 'issues', label: 'Issues', query: getTaskPresetQuery('issues') },
    { id: 'my-issues', label: 'My Issues', query: getTaskPresetQuery('my-issues') },
    { id: 'review', label: 'Needs My Review', query: getTaskPresetQuery('review') },
    { id: 'prs', label: 'PRs', query: getTaskPresetQuery('prs') },
    { id: 'my-prs', label: 'My PRs', query: getTaskPresetQuery('my-prs') }
];
const TASK_SEARCH_DEBOUNCE_MS = 300;
const WORK_ITEM_LIMIT = 36;
// Why: Intl.RelativeTimeFormat allocation is non-trivial, and previously we
// built a new formatter per work-item row render. Hoisting to module scope
// means all rows share one instance — zero per-row allocation cost.
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function formatRelativeTime(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
        return 'recently';
    }
    const diffMs = date.getTime() - Date.now();
    const diffMinutes = Math.round(diffMs / 60_000);
    if (Math.abs(diffMinutes) < 60) {
        return relativeTimeFormatter.format(diffMinutes, 'minute');
    }
    const diffHours = Math.round(diffMinutes / 60);
    if (Math.abs(diffHours) < 24) {
        return relativeTimeFormatter.format(diffHours, 'hour');
    }
    const diffDays = Math.round(diffHours / 24);
    return relativeTimeFormatter.format(diffDays, 'day');
}
function getTaskStatusLabel(item) {
    if (item.type === 'issue') {
        return 'Open';
    }
    if (item.state === 'draft') {
        return 'Draft';
    }
    return 'Ready';
}
function getTaskStatusTone(item) {
    if (item.type === 'issue') {
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200';
    }
    if (item.state === 'draft') {
        return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300';
    }
    return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200';
}
export default function NewWorkspacePage() {
    const settings = useAppStore((s) => s.settings);
    const pageData = useAppStore((s) => s.newWorkspacePageData);
    const closeNewWorkspacePage = useAppStore((s) => s.closeNewWorkspacePage);
    const clearNewWorkspaceDraft = useAppStore((s) => s.clearNewWorkspaceDraft);
    const activeModal = useAppStore((s) => s.activeModal);
    const openModal = useAppStore((s) => s.openModal);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const fetchWorkItems = useAppStore((s) => s.fetchWorkItems);
    const getCachedWorkItems = useAppStore((s) => s.getCachedWorkItems);
    const { cardProps, composerRef, promptTextareaRef, submit, createDisabled } = useComposerState({
        persistDraft: true,
        initialRepoId: pageData.preselectedRepoId,
        initialName: pageData.prefilledName,
        onCreated: () => {
            clearNewWorkspaceDraft();
            closeNewWorkspacePage();
        }
    });
    const { repoId, eligibleRepos, onRepoChange } = cardProps;
    const selectedRepo = eligibleRepos.find((repo) => repo.id === repoId);
    // Why: seed the preset + query from the user's saved default synchronously
    // so the first fetch effect issues exactly one request keyed to the final
    // query. Previously a separate effect "re-seeded" these after mount, which
    // caused a throwaway empty-query fetch followed by a second fetch for the
    // real default — doubling the time-to-first-paint of the list.
    const defaultTaskViewPreset = settings?.defaultTaskViewPreset ?? 'all';
    const initialTaskQuery = getTaskPresetQuery(defaultTaskViewPreset);
    const [taskSource, setTaskSource] = useState('github');
    const [taskSearchInput, setTaskSearchInput] = useState(initialTaskQuery);
    const [appliedTaskSearch, setAppliedTaskSearch] = useState(initialTaskQuery);
    const [activeTaskPreset, setActiveTaskPreset] = useState(defaultTaskViewPreset);
    const [tasksLoading, setTasksLoading] = useState(false);
    const [tasksError, setTasksError] = useState(null);
    const [taskRefreshNonce, setTaskRefreshNonce] = useState(0);
    // Why: the fetch effect uses this to detect when a nonce bump is from the
    // user clicking the refresh button (force=true) vs. re-running for any
    // other reason — e.g. a repo change while the nonce happens to be > 0.
    const lastFetchedNonceRef = useRef(-1);
    // Why: seed from the SWR cache so revisiting the page (or opening it after
    // a hover-prefetch) shows the list instantly while the background revalidate
    // keeps it current. Falls back to [] when nothing is cached yet.
    const [workItems, setWorkItems] = useState(() => {
        if (!selectedRepo) {
            return [];
        }
        return getCachedWorkItems(selectedRepo.path, WORK_ITEM_LIMIT, initialTaskQuery.trim()) ?? [];
    });
    // Why: clicking a GitHub row opens this drawer for a read-only preview.
    // The composer modal is only opened by the drawer's "Use" button, which
    // calls the same handleSelectWorkItem as the old direct row-click flow.
    const [drawerWorkItem, setDrawerWorkItem] = useState(null);
    const filteredWorkItems = useMemo(() => {
        if (!activeTaskPreset) {
            return workItems;
        }
        return workItems.filter((item) => {
            if (activeTaskPreset === 'issues') {
                return item.type === 'issue';
            }
            if (activeTaskPreset === 'review') {
                return item.type === 'pr';
            }
            if (activeTaskPreset === 'my-issues') {
                return item.type === 'issue';
            }
            if (activeTaskPreset === 'prs') {
                return item.type === 'pr';
            }
            if (activeTaskPreset === 'my-prs') {
                return item.type === 'pr';
            }
            return true;
        });
    }, [activeTaskPreset, workItems]);
    // Autofocus prompt on mount so the user can start typing immediately.
    useEffect(() => {
        promptTextareaRef.current?.focus();
    }, [promptTextareaRef]);
    useEffect(() => {
        const timeout = window.setTimeout(() => {
            setAppliedTaskSearch(taskSearchInput);
        }, TASK_SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timeout);
    }, [taskSearchInput]);
    useEffect(() => {
        if (taskSource !== 'github' || !selectedRepo) {
            return;
        }
        const trimmedQuery = appliedTaskSearch.trim();
        const repoPath = selectedRepo.path;
        // Why: SWR — render cached items instantly, then revalidate in the
        // background. Only show the spinner when we have nothing cached, so
        // repeat visits feel instant instead of flashing a loading state.
        const cached = getCachedWorkItems(repoPath, WORK_ITEM_LIMIT, trimmedQuery);
        if (cached) {
            setWorkItems(cached);
            setTasksError(null);
            setTasksLoading(false);
        }
        else {
            setTasksLoading(true);
            setTasksError(null);
        }
        let cancelled = false;
        // Why: force a refetch only when the nonce has incremented since the last
        // fetch (i.e. the user hit the refresh button or clicked a preset). Other
        // triggers — repo changes, search-box edits — should respect the SWR
        // cache's TTL instead of hammering `gh` on every keystroke.
        const forceRefresh = taskRefreshNonce !== lastFetchedNonceRef.current;
        lastFetchedNonceRef.current = taskRefreshNonce;
        // Why: the buttons below populate the same search bar the user can edit by
        // hand, so the fetch path has to honor both the preset GitHub query and any
        // ad-hoc qualifiers the user types (for example assignee:@me). The fetch is
        // debounced through `appliedTaskSearch` so backspacing all the way to empty
        // refires the query without spamming GitHub on every keystroke.
        void fetchWorkItems(repoPath, WORK_ITEM_LIMIT, trimmedQuery, {
            force: forceRefresh && taskRefreshNonce > 0
        })
            .then((items) => {
            if (!cancelled) {
                setWorkItems(items);
            }
        })
            .catch((error) => {
            if (!cancelled) {
                setTasksError(error instanceof Error ? error.message : 'Failed to load GitHub work.');
                if (!cached) {
                    setWorkItems([]);
                }
            }
        })
            .finally(() => {
            if (!cancelled) {
                setTasksLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
        // Why: getCachedWorkItems is a stable zustand selector; depending on it
        // would cause unnecessary effect re-runs on unrelated store updates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appliedTaskSearch, selectedRepo, taskRefreshNonce, taskSource, fetchWorkItems]);
    const handleApplyTaskSearch = useCallback(() => {
        const trimmed = taskSearchInput.trim();
        setTaskSearchInput(trimmed);
        setAppliedTaskSearch(trimmed);
        setActiveTaskPreset(null);
        setTaskRefreshNonce((current) => current + 1);
    }, [taskSearchInput]);
    const handleTaskSearchChange = useCallback((event) => {
        const next = event.target.value;
        setTaskSearchInput(next);
        setActiveTaskPreset(null);
    }, []);
    const handleSetDefaultTaskPreset = useCallback((presetId) => {
        // Why: the default task view is a durable preference, so right-clicking a
        // preset updates the persisted settings instead of only changing the
        // current page state.
        void updateSettings({ defaultTaskViewPreset: presetId }).catch(() => {
            toast.error('Failed to save default task view.');
        });
    }, [updateSettings]);
    const handleTaskSearchKeyDown = useCallback((event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleApplyTaskSearch();
        }
    }, [handleApplyTaskSearch]);
    const handleSelectWorkItem = useCallback((item) => {
        // Why: selecting a task from the list opens the same lightweight composer
        // modal used by Cmd+J, so the prompt path is identical whether the user
        // arrives via palette URL, picked issue/PR, or chose one from this list.
        const linkedWorkItem = {
            type: item.type,
            number: item.number,
            title: item.title,
            url: item.url
        };
        openModal('new-workspace-composer', {
            linkedWorkItem,
            prefilledName: getLinkedWorkItemSuggestedName(item),
            initialRepoId: repoId
        });
    }, [openModal, repoId]);
    const handleDiscardDraft = useCallback(() => {
        clearNewWorkspaceDraft();
        closeNewWorkspacePage();
    }, [clearNewWorkspaceDraft, closeNewWorkspacePage]);
    useEffect(() => {
        // Why: when the global composer modal is on top, let its own scoped key
        // handler own Enter/Esc so we don't double-fire (e.g. modal Esc closes
        // itself *and* this handler tries to discard the underlying page draft).
        if (activeModal === 'new-workspace-composer') {
            return;
        }
        const onKeyDown = (event) => {
            if (event.key !== 'Enter' && event.key !== 'Escape') {
                return;
            }
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }
            if (event.key === 'Escape') {
                // Why: Esc should first dismiss the focused control so users can back
                // out of text entry without accidentally closing the whole composer.
                // Once focus is already outside an input, Esc becomes the discard shortcut.
                if (target instanceof HTMLInputElement ||
                    target instanceof HTMLTextAreaElement ||
                    target instanceof HTMLSelectElement ||
                    target.isContentEditable) {
                    event.preventDefault();
                    target.blur();
                    return;
                }
                event.preventDefault();
                handleDiscardDraft();
                return;
            }
            if (!composerRef.current?.contains(target)) {
                return;
            }
            if (createDisabled) {
                return;
            }
            if (target instanceof HTMLTextAreaElement && event.shiftKey) {
                return;
            }
            event.preventDefault();
            void submit();
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [activeModal, composerRef, createDisabled, handleDiscardDraft, submit]);
    return (_jsxs("div", { className: "relative flex h-full min-h-0 flex-1 overflow-hidden bg-background dark:bg-[#1a1a1a] text-foreground", children: [_jsx(LightRays, { count: 3, color: "rgba(120, 160, 255, 0.15)", blur: 20, speed: 16, length: "60vh", className: "z-0" }), selectedRepo?.badgeColor && (_jsx("div", { className: "pointer-events-none absolute inset-0 z-0 opacity-30 transition-opacity duration-700 ease-in-out", style: {
                    background: `radial-gradient(circle at top right, ${selectedRepo.badgeColor}, transparent 75%)`
                } })), _jsxs("div", { className: "relative z-10 flex min-h-0 flex-1 flex-col", children: [_jsx("div", { className: "flex-none flex items-center justify-start px-5 py-3 md:px-8 md:py-4", children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon", className: "size-8 rounded-full z-10", onClick: handleDiscardDraft, "aria-label": "Discard draft and go back", children: _jsx(X, { className: "size-4" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Discard draft \u00B7 Esc" })] }) }), _jsxs("div", { className: "mx-auto flex w-full max-w-[1120px] flex-1 flex-col min-h-0 px-5 pb-5 md:px-8 md:pb-7", children: [_jsxs("div", { className: "flex-none flex flex-col gap-5", children: [_jsx("section", { className: "mx-auto w-full max-w-[860px] border-b border-border/50 pb-5", children: _jsx(NewWorkspaceComposerCard, { composerRef: composerRef, ...cardProps }) }), _jsx("section", { className: "flex flex-col gap-4", children: _jsxs("div", { className: "flex flex-col gap-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { className: "flex items-center gap-2", children: SOURCE_OPTIONS.map((source) => {
                                                                const active = taskSource === source.id;
                                                                return (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { type: "button", disabled: source.disabled, onClick: () => setTaskSource(source.id), "aria-label": source.label, className: cn('group flex h-11 w-11 items-center justify-center rounded-xl border transition', active
                                                                                    ? 'border-border/50 bg-background/50 backdrop-blur-md supports-[backdrop-filter]:bg-background/50'
                                                                                    : 'border-border/50 bg-transparent hover:bg-muted/40', source.disabled && 'cursor-not-allowed opacity-55'), children: _jsx(source.Icon, { className: "size-4 text-foreground" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: source.label })] }, source.id));
                                                            }) }), _jsx("div", { className: "w-[240px]", children: _jsx(RepoCombobox, { repos: eligibleRepos, value: repoId, onValueChange: onRepoChange, placeholder: "Select a repository", triggerClassName: "h-11 w-full rounded-[10px] border border-border/50 bg-background/50 backdrop-blur-md px-3 text-sm font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none supports-[backdrop-filter]:bg-background/50" }) })] }), taskSource === 'github' && (_jsxs("div", { className: "rounded-[16px] border border-border/50 bg-background/40 backdrop-blur-md p-4 shadow-sm supports-[backdrop-filter]:bg-background/40", children: [_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-3", children: [_jsx("div", { className: "flex flex-wrap gap-2", children: TASK_QUERY_PRESETS.map((option) => {
                                                                        const active = activeTaskPreset === option.id;
                                                                        return (_jsx("button", { type: "button", onClick: () => {
                                                                                const query = option.query;
                                                                                setTaskSearchInput(query);
                                                                                setAppliedTaskSearch(query);
                                                                                setActiveTaskPreset(option.id);
                                                                                setTaskRefreshNonce((current) => current + 1);
                                                                            }, onContextMenu: (event) => {
                                                                                event.preventDefault();
                                                                                handleSetDefaultTaskPreset(option.id);
                                                                            }, className: cn('rounded-xl border px-3 py-2 text-sm transition', active
                                                                                ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                                                                                : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'), children: option.label }, option.id));
                                                                    }) }), _jsx("div", { className: "flex shrink-0 items-center gap-2", children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "outline", size: "icon", onClick: () => setTaskRefreshNonce((current) => current + 1), disabled: tasksLoading, "aria-label": "Refresh GitHub work", className: "border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent", children: tasksLoading ? (_jsx(LoaderCircle, { className: "size-4 animate-spin" })) : (_jsx(RefreshCw, { className: "size-4" })) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Refresh GitHub work" })] }) })] }), _jsx("div", { className: "mt-4 flex flex-wrap items-center gap-3", children: _jsxs("div", { className: "relative min-w-[320px] flex-1", children: [_jsx(Search, { className: "pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" }), _jsx(Input, { value: taskSearchInput, onChange: handleTaskSearchChange, onKeyDown: handleTaskSearchKeyDown, placeholder: "GitHub search, e.g. assignee:@me is:open", className: "h-10 border-border/50 bg-background/50 pl-10 pr-10 backdrop-blur-md supports-[backdrop-filter]:bg-background/50" }), taskSearchInput || appliedTaskSearch ? (_jsx("button", { type: "button", "aria-label": "Clear search", onClick: () => {
                                                                            setTaskSearchInput('');
                                                                            setAppliedTaskSearch('');
                                                                            setActiveTaskPreset(null);
                                                                            setTaskRefreshNonce((current) => current + 1);
                                                                        }, className: "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground", children: _jsx(X, { className: "size-4" }) })) : null] }) })] }))] }) })] }), taskSource === 'github' ? (_jsxs("div", { className: "mt-4 flex flex-1 flex-col min-h-0 rounded-[16px] border border-border/50 bg-background/30 backdrop-blur-md supports-[backdrop-filter]:bg-background/30 overflow-hidden shadow-sm", children: [_jsxs("div", { className: "flex-none hidden grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px] gap-4 border-b border-border/50 px-4 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground lg:grid", children: [_jsx("span", { children: "ID" }), _jsx("span", { children: "Title / Context" }), _jsx("span", { children: "Source Branch" }), _jsx("span", { children: "System Status" }), _jsx("span", { children: "Updated" }), _jsx("span", {})] }), _jsxs("div", { className: "flex-1 overflow-y-auto scrollbar-sleek", style: { scrollbarGutter: 'stable' }, children: [tasksError ? (_jsx("div", { className: "border-b border-border px-4 py-4 text-sm text-destructive", children: tasksError })) : null, !tasksLoading && filteredWorkItems.length === 0 ? (_jsxs("div", { className: "px-4 py-10 text-center", children: [_jsx("p", { className: "text-base font-medium text-foreground", children: "No matching GitHub work" }), _jsx("p", { className: "mt-2 text-sm text-muted-foreground", children: "Change the query or clear it." })] })) : null, _jsx("div", { className: "divide-y divide-border/50", children: filteredWorkItems.map((item) => {
                                                    return (_jsxs("button", { type: "button", onClick: () => setDrawerWorkItem(item), className: "grid w-full gap-4 px-4 py-4 text-left transition hover:bg-muted/40 lg:grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px]", children: [_jsx("div", { className: "flex items-center", children: _jsxs("span", { className: "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-1.5 text-muted-foreground", children: [item.type === 'pr' ? (_jsx(GitPullRequest, { className: "size-3.5" })) : (_jsx(CircleDot, { className: "size-3.5" })), _jsxs("span", { className: "font-mono text-[13px] font-normal", children: ["#", item.number] })] }) }), _jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [item.type === 'pr' ? (_jsx(GitPullRequest, { className: "size-4 text-muted-foreground" })) : (_jsx(CircleDot, { className: "size-4 text-muted-foreground" })), _jsx("h3", { className: "truncate text-[15px] font-semibold text-foreground", children: item.title })] }), _jsxs("div", { className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground", children: [_jsx("span", { children: item.author ?? 'unknown author' }), _jsx("span", { children: selectedRepo?.displayName }), item.labels.slice(0, 3).map((label) => (_jsx("span", { className: "rounded-full border border-border/50 bg-background/50 backdrop-blur-md px-2 py-0.5 text-[11px] text-muted-foreground supports-[backdrop-filter]:bg-background/50", children: label }, label)))] })] }), _jsx("div", { className: "min-w-0 flex items-center text-sm text-muted-foreground", children: _jsx("span", { className: "truncate", children: item.branchName || item.baseRefName || 'workspace/default' }) }), _jsx("div", { className: "flex items-center", children: _jsx("span", { className: cn('rounded-full border px-2.5 py-1 text-xs font-medium', getTaskStatusTone(item)), children: getTaskStatusLabel(item) }) }), _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("div", { className: "flex items-center text-sm text-muted-foreground", children: formatRelativeTime(item.updatedAt) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: new Date(item.updatedAt).toLocaleString() })] }), _jsxs("div", { className: "flex items-center justify-start gap-1 lg:justify-end", children: [_jsxs("button", { type: "button", onClick: (e) => {
                                                                            e.stopPropagation();
                                                                            handleSelectWorkItem(item);
                                                                        }, className: "inline-flex items-center gap-1 rounded-xl border border-border/50 bg-background/50 backdrop-blur-md px-3 py-1.5 text-sm text-foreground transition hover:bg-muted/60 supports-[backdrop-filter]:bg-background/50", children: ["Use", _jsx(ArrowRight, { className: "size-4" })] }), _jsxs(DropdownMenu, { modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { type: "button", onClick: (e) => e.stopPropagation(), className: "rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground", "aria-label": "More actions", children: _jsx(EllipsisVertical, { className: "size-4" }) }) }), _jsx(DropdownMenuContent, { align: "end", onClick: (e) => e.stopPropagation(), children: _jsxs(DropdownMenuItem, { onSelect: () => window.open(item.url, '_blank'), children: [_jsx(ExternalLink, { className: "size-4" }), "Open in browser"] }) })] })] })] }, item.id));
                                                }) })] })] })) : (_jsx("div", { className: "mt-4 px-1 py-6", children: _jsx("p", { className: "text-sm text-muted-foreground", children: "Coming soon" }) }))] })] }), _jsx(GitHubItemDrawer, { workItem: drawerWorkItem, repoPath: selectedRepo?.path ?? null, onUse: (item) => {
                    setDrawerWorkItem(null);
                    handleSelectWorkItem(item);
                }, onClose: () => setDrawerWorkItem(null) })] }));
}
