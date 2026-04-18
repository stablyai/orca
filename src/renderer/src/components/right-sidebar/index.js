import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useMemo, useState } from 'react';
import { Files, Search, GitBranch, ListChecks, PanelRight } from 'lucide-react';
import { useAppStore } from '@/store';
import { cn } from '@/lib/utils';
import { useSidebarResize } from '@/hooks/useSidebarResize';
import { isFolderRepo } from '../../../../shared/repo-kind';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuLabel, ContextMenuRadioGroup, ContextMenuRadioItem } from '@/components/ui/context-menu';
import FileExplorer from './FileExplorer';
import SourceControl from './SourceControl';
import SearchPanel from './Search';
import ChecksPanel from './ChecksPanel';
const MIN_WIDTH = 220;
// Why: long file names (e.g. construction drawing sheets, multi-part document
// names) used to be truncated at a hard 500px cap that no drag could exceed.
// We now let the user drag up to nearly the full window width and only keep a
// small reserve so the rest of the app (left sidebar, editor) is not squeezed
// to zero — the practical ceiling still scales with the user's window size.
const MIN_NON_SIDEBAR_AREA = 320;
const ABSOLUTE_FALLBACK_MAX_WIDTH = 2000;
const ACTIVITY_BAR_SIDE_WIDTH = 40;
function branchDisplayName(branch) {
    return branch.replace(/^refs\/heads\//, '');
}
function findWorktreeById(worktreesByRepo, worktreeId) {
    if (!worktreeId) {
        return null;
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
        const worktree = worktrees.find((entry) => entry.id === worktreeId);
        if (worktree) {
            return worktree;
        }
    }
    return null;
}
function getActiveChecksStatus(state) {
    const activeWorktree = findWorktreeById(state.worktreesByRepo, state.activeWorktreeId);
    if (!activeWorktree) {
        return null;
    }
    const activeRepo = state.repos.find((repo) => repo.id === activeWorktree.repoId);
    if (!activeRepo) {
        return null;
    }
    const branch = branchDisplayName(activeWorktree.branch);
    if (!branch) {
        return null;
    }
    const prCacheKey = `${activeRepo.path}::${branch}`;
    return state.prCache[prCacheKey]?.data?.checksStatus ?? null;
}
const isMac = navigator.userAgent.includes('Mac');
const mod = isMac ? '\u2318' : 'Ctrl+';
const ACTIVITY_ITEMS = [
    {
        id: 'explorer',
        icon: Files,
        title: 'Explorer',
        shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}E`
    },
    {
        id: 'search',
        icon: Search,
        title: 'Search',
        shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}F`
    },
    {
        id: 'source-control',
        icon: GitBranch,
        title: 'Source Control',
        shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}G`,
        gitOnly: true
    },
    {
        id: 'checks',
        icon: ListChecks,
        title: 'Checks',
        shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}K`,
        gitOnly: true
    }
];
function RightSidebarInner() {
    const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen);
    const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth);
    const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth);
    const rightSidebarTab = useAppStore((s) => s.rightSidebarTab);
    const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab);
    const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
    const checksStatus = useAppStore(getActiveChecksStatus);
    const activityBarPosition = useAppStore((s) => s.activityBarPosition);
    const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition);
    // Why: source control and checks are meaningless for non-git folders.
    // Hide those tabs so the activity bar only shows relevant actions.
    const activeRepo = useAppStore((s) => {
        const wt = findWorktreeById(s.worktreesByRepo, s.activeWorktreeId);
        return wt ? (s.repos.find((r) => r.id === wt.repoId) ?? null) : null;
    });
    const isFolder = activeRepo ? isFolderRepo(activeRepo) : false;
    const visibleItems = useMemo(() => (isFolder ? ACTIVITY_ITEMS.filter((item) => !item.gitOnly) : ACTIVITY_ITEMS), [isFolder]);
    // If the active tab is hidden (e.g. switched from a git repo to a folder),
    // fall back to the first visible tab.
    const effectiveTab = visibleItems.some((item) => item.id === rightSidebarTab)
        ? rightSidebarTab
        : visibleItems[0].id;
    const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0;
    const maxWidth = useWindowAwareMaxWidth();
    const { containerRef, onResizeStart } = useSidebarResize({
        isOpen: rightSidebarOpen,
        width: rightSidebarWidth,
        minWidth: MIN_WIDTH,
        maxWidth,
        deltaSign: -1,
        renderedExtraWidth: activityBarSideWidth,
        setWidth: setRightSidebarWidth
    });
    const panelContent = (_jsxs("div", { className: "flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent", children: [effectiveTab === 'explorer' && _jsx(FileExplorer, {}), effectiveTab === 'search' && _jsx(SearchPanel, {}), effectiveTab === 'source-control' && _jsx(SourceControl, {}), effectiveTab === 'checks' && _jsx(ChecksPanel, {})] }));
    const activityBarIcons = visibleItems.map((item) => (_jsx(ActivityBarButton, { item: item, active: effectiveTab === item.id, onClick: () => setRightSidebarTab(item.id), layout: activityBarPosition, statusIndicator: item.id === 'checks' ? checksStatus : null }, item.id)));
    const closeButton = rightSidebarOpen ? (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { type: "button", className: "sidebar-toggle mr-1", onClick: toggleRightSidebar, "aria-label": "Toggle right sidebar", children: _jsx(PanelRight, { size: 16 }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: `Toggle right sidebar (${isMac ? '⌘L' : 'Ctrl+L'})` })] })) : null;
    return (_jsxs("div", { ref: containerRef, className: cn('relative flex-shrink-0 flex flex-row', 
        // Why: overflow-visible is needed when open so the resize handle
        // on the left edge remains interactive.  When closed (width 0),
        // switch to overflow-hidden so the activity bar icons and panel
        // content don't leak past the 0-width boundary (the component
        // stays mounted for performance — see App.tsx).
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'), children: [_jsxs("div", { className: "flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden", style: {
                    borderLeft: rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
                }, children: [activityBarPosition === 'top' ? (
                    /* ── Top activity bar: horizontal icon row ── */
                    _jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsx("div", { className: "flex items-center justify-between border-b border-border h-[42px] min-h-[42px] pl-2 pr-1", children: _jsxs(TooltipProvider, { delayDuration: 400, children: [_jsx("div", { className: "flex items-center", children: activityBarIcons }), closeButton] }) }) }), _jsx(ActivityBarPositionMenu, { currentPosition: activityBarPosition, onChangePosition: setActivityBarPosition })] })) : (
                    /* ── Side layout: static title header ── */
                    _jsxs("div", { className: "flex items-center justify-between h-[42px] min-h-[42px] px-3 border-b border-border", children: [_jsx("span", { className: "text-[11px] font-semibold uppercase tracking-wider text-foreground", children: visibleItems.find((item) => item.id === effectiveTab)?.title ?? '' }), _jsx(TooltipProvider, { delayDuration: 400, children: closeButton })] })), panelContent, _jsx("div", { className: "absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10", onMouseDown: onResizeStart })] }), activityBarPosition === 'side' && (_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsx("div", { className: "flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-l border-border", children: _jsx(TooltipProvider, { delayDuration: 400, children: activityBarIcons }) }) }), _jsx(ActivityBarPositionMenu, { currentPosition: activityBarPosition, onChangePosition: setActivityBarPosition })] }))] }));
}
const RightSidebar = React.memo(RightSidebarInner);
export default RightSidebar;
// Why: the drag-resize max is a function of window width, not a constant, so
// users with wide displays can expand the sidebar far enough to read long file
// names. Falls back to a large constant in non-DOM environments (tests).
function useWindowAwareMaxWidth() {
    const [max, setMax] = useState(() => computeMaxRightSidebarWidth());
    useEffect(() => {
        function update() {
            setMax(computeMaxRightSidebarWidth());
        }
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);
    return max;
}
function computeMaxRightSidebarWidth() {
    if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) {
        return ABSOLUTE_FALLBACK_MAX_WIDTH;
    }
    return Math.max(MIN_WIDTH, window.innerWidth - MIN_NON_SIDEBAR_AREA);
}
// ─── Status indicator dot color mapping ──────
const STATUS_DOT_COLOR = {
    success: 'bg-emerald-500',
    failure: 'bg-rose-500',
    pending: 'bg-amber-500',
    neutral: 'bg-muted-foreground'
};
// ─── Activity Bar Button (shared for top + side) ──────
function ActivityBarButton({ item, active, onClick, layout, statusIndicator }) {
    const Icon = item.icon;
    const isTop = layout === 'top';
    return (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs("button", { className: cn('relative flex items-center justify-center transition-colors', isTop ? 'h-[42px] w-9' : 'w-10 h-10', active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'), onClick: onClick, "aria-label": `${item.title} (${item.shortcut})`, children: [_jsx(Icon, { size: isTop ? 16 : 18 }), statusIndicator && statusIndicator !== 'neutral' && (_jsx("div", { className: cn('absolute rounded-full size-[7px] ring-1 ring-sidebar', isTop ? 'top-[8px] right-[5px]' : 'top-[7px] right-[7px]', STATUS_DOT_COLOR[statusIndicator] ?? 'bg-muted-foreground') })), active && isTop && (_jsx("div", { className: "absolute bottom-0 left-[25%] right-[25%] h-[2px] bg-foreground rounded-t" })), active && !isTop && (_jsx("div", { className: "absolute right-0 top-[25%] bottom-[25%] w-[2px] bg-foreground rounded-l" }))] }) }), _jsxs(TooltipContent, { side: isTop ? 'bottom' : 'left', sideOffset: 6, children: [item.title, " (", item.shortcut, ")"] })] }));
}
// ─── Context Menu for Activity Bar Position ───────────
function ActivityBarPositionMenu({ currentPosition, onChangePosition }) {
    return (_jsxs(ContextMenuContent, { children: [_jsx(ContextMenuLabel, { children: "Activity Bar Position" }), _jsxs(ContextMenuRadioGroup, { value: currentPosition, onValueChange: (v) => onChangePosition(v), children: [_jsx(ContextMenuRadioItem, { value: "top", children: "Top" }), _jsx(ContextMenuRadioItem, { value: "side", children: "Side" })] })] }));
}
