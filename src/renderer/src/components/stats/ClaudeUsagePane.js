import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect } from 'react';
import { Activity, Coins, DatabaseZap, FolderKanban, Gauge, RefreshCw, SlidersHorizontal, Sparkles, Waypoints } from 'lucide-react';
import { useAppStore } from '../../store';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart';
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState';
import { StatCard } from './StatCard';
const RANGE_OPTIONS = ['7d', '30d', '90d', 'all'];
const SCOPE_OPTIONS = [
    { value: 'orca', label: 'Orca worktrees only' },
    { value: 'all', label: 'All local Claude usage' }
];
const RANGE_LABELS = {
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    all: 'All time'
};
function formatTokens(value) {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}k`;
    }
    return value.toLocaleString();
}
function formatCost(value) {
    if (value === null) {
        return 'n/a';
    }
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
function formatUpdatedAt(timestamp) {
    if (!timestamp) {
        return 'Not scanned yet';
    }
    return `Updated ${new Date(timestamp).toLocaleString()}`;
}
function formatSessionTime(timestamp) {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return timestamp;
    }
    return parsed.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}
export function ClaudeUsagePane() {
    const scanState = useAppStore((state) => state.claudeUsageScanState);
    const summary = useAppStore((state) => state.claudeUsageSummary);
    const daily = useAppStore((state) => state.claudeUsageDaily);
    const modelBreakdown = useAppStore((state) => state.claudeUsageModelBreakdown);
    const projectBreakdown = useAppStore((state) => state.claudeUsageProjectBreakdown);
    const recentSessions = useAppStore((state) => state.claudeUsageRecentSessions);
    const scope = useAppStore((state) => state.claudeUsageScope);
    const range = useAppStore((state) => state.claudeUsageRange);
    const fetchClaudeUsage = useAppStore((state) => state.fetchClaudeUsage);
    const setClaudeUsageEnabled = useAppStore((state) => state.setClaudeUsageEnabled);
    const refreshClaudeUsage = useAppStore((state) => state.refreshClaudeUsage);
    const setClaudeUsageScope = useAppStore((state) => state.setClaudeUsageScope);
    const setClaudeUsageRange = useAppStore((state) => state.setClaudeUsageRange);
    useEffect(() => {
        void fetchClaudeUsage();
    }, [fetchClaudeUsage]);
    if (!scanState?.enabled) {
        return (_jsx("div", { className: "rounded-lg border border-border/60 bg-card/40 p-4", children: _jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx("h3", { className: "text-sm font-semibold text-foreground", children: "Claude Usage Tracking" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Reads local Claude usage logs to show token, model, and session stats." })] }), _jsx("button", { type: "button", role: "switch", "aria-checked": false, "aria-label": "Enable Claude usage analytics", onClick: () => void setClaudeUsageEnabled(true), className: "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-muted-foreground/30 transition-colors", children: _jsx("span", { className: "pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform" }) })] }) }));
    }
    if (!summary && (scanState.isScanning || scanState.lastScanCompletedAt === null)) {
        return _jsx(ClaudeUsageLoadingState, {});
    }
    const hasAnyData = summary?.hasAnyClaudeData ?? scanState.hasAnyClaudeData;
    return (_jsxs("div", { className: "space-y-4 rounded-lg border border-border/60 bg-card/30 p-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("h3", { className: "text-sm font-semibold text-foreground", children: "Claude Usage Tracking" }), _jsxs("p", { className: "mt-1 text-xs text-muted-foreground", children: [formatUpdatedAt(scanState.lastScanCompletedAt), scanState.lastScanError ? ` • Last scan error: ${scanState.lastScanError}` : ''] })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-2 self-start", children: [_jsxs(DropdownMenu, { children: [_jsx(TooltipProvider, { delayDuration: 250, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-xs", "aria-label": "Claude usage options", children: _jsx(SlidersHorizontal, { className: "size-3.5" }) }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Filters" })] }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-60", children: [_jsx(DropdownMenuLabel, { children: "Scope" }), _jsx(DropdownMenuRadioGroup, { value: scope, onValueChange: (value) => void setClaudeUsageScope(value), children: SCOPE_OPTIONS.map((option) => (_jsx(DropdownMenuRadioItem, { value: option.value, children: option.label }, option.value))) }), _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuLabel, { children: "Range" }), _jsx(DropdownMenuRadioGroup, { value: range, onValueChange: (value) => void setClaudeUsageRange(value), children: RANGE_OPTIONS.map((option) => (_jsx(DropdownMenuRadioItem, { value: option, children: RANGE_LABELS[option] }, option))) })] })] }), _jsx(TooltipProvider, { delayDuration: 250, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-xs", onClick: () => void refreshClaudeUsage(), disabled: scanState.isScanning, "aria-label": "Refresh Claude usage", children: _jsx(RefreshCw, { className: `size-3.5 ${scanState.isScanning ? 'animate-spin' : ''}` }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Refresh" })] }) }), _jsx("button", { type: "button", role: "switch", "aria-checked": true, "aria-label": "Enable Claude usage analytics", onClick: () => void setClaudeUsageEnabled(false), className: "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-foreground transition-colors", children: _jsx("span", { className: "pointer-events-none block size-3.5 translate-x-4 rounded-full bg-background shadow-sm transition-transform" }) })] })] }), _jsx("div", { className: "flex items-center justify-between gap-3", children: _jsxs("p", { className: "text-xs text-muted-foreground", children: [SCOPE_OPTIONS.find((option) => option.value === scope)?.label, " \u2022 ", RANGE_LABELS[range]] }) }), !hasAnyData ? (_jsx("div", { className: "rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-sm text-muted-foreground", children: "No local Claude usage found yet for this scope." })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid gap-3 md:grid-cols-2 xl:grid-cols-4", children: [_jsx(StatCard, { label: "Input tokens", value: formatTokens(summary?.inputTokens ?? 0), icon: _jsx(Sparkles, { className: "size-4" }) }), _jsx(StatCard, { label: "Output tokens", value: formatTokens(summary?.outputTokens ?? 0), icon: _jsx(Activity, { className: "size-4" }) }), _jsx(StatCard, { label: "Cache read", value: formatTokens(summary?.cacheReadTokens ?? 0), icon: _jsx(DatabaseZap, { className: "size-4" }) }), _jsx(StatCard, { label: "Cache write", value: formatTokens(summary?.cacheWriteTokens ?? 0), icon: _jsx(Waypoints, { className: "size-4" }) }), _jsx(StatCard, { label: "Cache reuse rate", value: summary?.cacheReuseRate !== null && summary?.cacheReuseRate !== undefined
                                    ? `${Math.round(summary.cacheReuseRate * 100)}%`
                                    : 'n/a', icon: _jsx(Gauge, { className: "size-4" }) }), _jsx(StatCard, { label: "Zero-cache-read turns", value: summary && summary.turns > 0
                                    ? `${Math.round((summary.zeroCacheReadTurns / summary.turns) * 100)}%`
                                    : 'n/a', icon: _jsx(DatabaseZap, { className: "size-4" }) }), _jsx(StatCard, { label: "Sessions / Turns", value: `${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.turns ?? 0).toLocaleString()}`, icon: _jsx(FolderKanban, { className: "size-4" }) }), _jsx(StatCard, { label: "Est. API-equivalent cost", value: formatCost(summary?.estimatedCostUsd ?? null), icon: _jsx(Coins, { className: "size-4" }) })] }), _jsx("p", { className: "px-1 text-xs text-muted-foreground", children: "Cache reuse rate is calculated as cache read tokens / (input tokens + cache read tokens)." }), _jsx(ClaudeUsageDailyChart, { daily: daily }), _jsxs("div", { className: "grid gap-4 xl:grid-cols-2", children: [_jsxs("section", { className: "rounded-lg border border-border/60 bg-card/40 p-4", children: [_jsxs("div", { className: "mb-3", children: [_jsx("h4", { className: "text-sm font-semibold text-foreground", children: "By model" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Top model: ", summary?.topModel ?? 'n/a'] })] }), _jsx("div", { className: "space-y-3", children: modelBreakdown.slice(0, 5).map((row) => (_jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex items-center justify-between gap-3 text-sm", children: [_jsx("span", { className: "truncate text-foreground", children: row.label }), _jsx("span", { className: "shrink-0 text-muted-foreground", children: formatTokens(row.inputTokens + row.outputTokens) })] }), _jsxs("div", { className: "text-xs text-muted-foreground", children: [row.sessions, " sessions \u2022 ", row.turns, " turns"] })] }, row.key))) })] }), _jsxs("section", { className: "rounded-lg border border-border/60 bg-card/40 p-4", children: [_jsxs("div", { className: "mb-3", children: [_jsx("h4", { className: "text-sm font-semibold text-foreground", children: "By project" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Top project: ", summary?.topProject ?? 'n/a'] })] }), _jsx("div", { className: "space-y-3", children: projectBreakdown.slice(0, 5).map((row) => (_jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex items-center justify-between gap-3 text-sm", children: [_jsx("span", { className: "truncate text-foreground", children: row.label }), _jsx("span", { className: "shrink-0 text-muted-foreground", children: formatTokens(row.inputTokens + row.outputTokens) })] }), _jsxs("div", { className: "text-xs text-muted-foreground", children: [row.sessions, " sessions \u2022 ", row.turns, " turns"] })] }, row.key))) })] })] }), _jsxs("section", { className: "rounded-lg border border-border/60 bg-card/40 p-4", children: [_jsxs("div", { className: "mb-3", children: [_jsx("h4", { className: "text-sm font-semibold text-foreground", children: "Recent sessions" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Cache reuse rate:", ' ', summary?.cacheReuseRate !== null && summary?.cacheReuseRate !== undefined
                                                ? `${Math.round(summary.cacheReuseRate * 100)}%`
                                                : 'n/a'] })] }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "min-w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-border/60 text-left text-xs text-muted-foreground", children: [_jsx("th", { className: "px-2 py-2 font-medium", children: "Last active" }), _jsx("th", { className: "px-2 py-2 font-medium", children: "Project" }), _jsx("th", { className: "px-2 py-2 font-medium", children: "Model" }), _jsx("th", { className: "px-2 py-2 font-medium", children: "Turns" }), _jsx("th", { className: "px-2 py-2 font-medium", children: "Input" }), _jsx("th", { className: "px-2 py-2 font-medium", children: "Output" }), _jsx("th", { className: "px-2 py-2 font-medium", children: "Cache" })] }) }), _jsx("tbody", { children: recentSessions.map((row) => (_jsxs("tr", { className: "border-b border-border/40 last:border-b-0", children: [_jsx("td", { className: "px-2 py-2 text-muted-foreground", children: formatSessionTime(row.lastActiveAt) }), _jsx("td", { className: "px-2 py-2 text-foreground", children: row.projectLabel }), _jsx("td", { className: "px-2 py-2 text-muted-foreground", children: row.model ?? 'Unknown' }), _jsx("td", { className: "px-2 py-2 text-muted-foreground", children: row.turns }), _jsx("td", { className: "px-2 py-2 text-muted-foreground", children: formatTokens(row.inputTokens) }), _jsx("td", { className: "px-2 py-2 text-muted-foreground", children: formatTokens(row.outputTokens) }), _jsx("td", { className: "px-2 py-2 text-muted-foreground", children: formatTokens(row.cacheReadTokens + row.cacheWriteTokens) })] }, row.sessionId))) })] }) })] })] }))] }));
}
