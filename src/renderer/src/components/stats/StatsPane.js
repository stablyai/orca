import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Bot, Clock, GitPullRequest } from 'lucide-react';
import { useAppStore } from '../../store';
import { StatCard } from './StatCard';
import { ClaudeUsagePane } from './ClaudeUsagePane';
import { CodexUsagePane } from './CodexUsagePane';
import { cn } from '@/lib/utils';
export const STATS_PANE_SEARCH_ENTRIES = [
    {
        title: 'Stats & Usage',
        description: 'Orca stats plus Claude and Codex usage analytics, tokens, cache, models, and sessions.',
        keywords: [
            'stats',
            'usage',
            'statistics',
            'agents',
            'prs',
            'time',
            'tracking',
            'claude',
            'codex',
            'tokens',
            'cache'
        ]
    }
];
function formatDuration(ms) {
    if (ms <= 0) {
        return '0m';
    }
    const totalMinutes = Math.floor(ms / 60_000);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    const remainingMinutes = totalMinutes % 60;
    if (totalDays > 0) {
        return `${totalDays}d ${remainingHours}h`;
    }
    if (totalHours > 0) {
        return `${totalHours}h ${remainingMinutes}m`;
    }
    return `${totalMinutes}m`;
}
function formatTrackingSince(timestamp) {
    if (!timestamp) {
        return '';
    }
    const date = new Date(timestamp);
    return `Tracking since ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
export function StatsPane() {
    const summary = useAppStore((s) => s.statsSummary);
    const fetchStatsSummary = useAppStore((s) => s.fetchStatsSummary);
    const [activeUsageTab, setActiveUsageTab] = useState('claude');
    useEffect(() => {
        void fetchStatsSummary();
    }, [fetchStatsSummary]);
    return (_jsxs("div", { className: "space-y-5", children: [summary ? (_jsx("div", { className: "space-y-3", children: summary.totalAgentsSpawned === 0 && summary.totalPRsCreated === 0 ? (_jsx("div", { className: "flex min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground", children: "Start your first agent to begin tracking" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-3 gap-3", children: [_jsx(StatCard, { label: "Agents spawned", value: summary.totalAgentsSpawned.toLocaleString(), icon: _jsx(Bot, { className: "size-4" }) }), _jsx(StatCard, { label: "Time agents worked", value: formatDuration(summary.totalAgentTimeMs), icon: _jsx(Clock, { className: "size-4" }) }), _jsx(StatCard, { label: "PRs created", value: summary.totalPRsCreated.toLocaleString(), icon: _jsx(GitPullRequest, { className: "size-4" }) })] }), formatTrackingSince(summary.firstEventAt) && (_jsx("p", { className: "px-1 text-xs text-muted-foreground", children: formatTrackingSince(summary.firstEventAt) }))] })) })) : null, _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("h3", { className: "text-sm font-semibold text-foreground", children: "Usage Analytics" }), _jsx("div", { role: "group", "aria-label": "Usage analytics provider", className: "inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground", children: ['claude', 'codex'].map((tab) => (_jsx("button", { type: "button", "aria-pressed": activeUsageTab === tab, onClick: () => setActiveUsageTab(tab), className: cn('inline-flex h-8 items-center justify-center rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all', activeUsageTab === tab
                                        ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30'
                                        : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground'), children: tab === 'claude' ? 'Claude' : 'Codex' }, tab))) })] }), _jsx("div", { children: activeUsageTab === 'claude' ? _jsx(ClaudeUsagePane, {}) : _jsx(CodexUsagePane, {}) })] })] }));
}
