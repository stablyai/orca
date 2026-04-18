import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
function formatTokens(value) {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}k`;
    }
    return value.toLocaleString();
}
export function ClaudeUsageDailyChart({ daily }) {
    const maxDailyTotal = Math.max(1, ...daily.map((entry) => entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens));
    return (_jsxs("section", { className: "rounded-lg border border-border/60 bg-card/40 p-4", children: [_jsxs("div", { className: "mb-3", children: [_jsx("h4", { className: "text-sm font-semibold text-foreground", children: "Daily usage" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Input, output, cache read, and cache write totals by day." })] }), _jsx("div", { className: "grid h-56 grid-cols-10 items-end gap-3", children: daily.slice(-10).map((entry) => {
                    const total = entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
                    const segments = [
                        {
                            key: 'cache-write',
                            label: 'Cache write',
                            value: entry.cacheWriteTokens,
                            className: 'bg-fuchsia-500/70'
                        },
                        {
                            key: 'cache-read',
                            label: 'Cache read',
                            value: entry.cacheReadTokens,
                            className: 'bg-amber-500/70'
                        },
                        {
                            key: 'output',
                            label: 'Output',
                            value: entry.outputTokens,
                            className: 'bg-emerald-500/80'
                        },
                        { key: 'input', label: 'Input', value: entry.inputTokens, className: 'bg-sky-500/80' }
                    ];
                    return (_jsxs("div", { className: "flex h-full min-w-0 flex-col justify-end gap-2", children: [_jsx("span", { className: "text-center text-[11px] text-muted-foreground", children: formatTokens(total) }), _jsx("div", { className: "flex min-h-0 flex-1 items-end justify-center", children: _jsx("div", { className: "flex h-full w-full max-w-12 overflow-hidden rounded-t-sm bg-muted/60", children: _jsx("div", { className: "flex h-full w-full flex-col justify-end", children: segments.map((segment) => segment.value > 0 ? (_jsx(TooltipProvider, { delayDuration: 120, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("div", { className: segment.className, style: { height: `${(segment.value / maxDailyTotal) * 100}%` } }) }), _jsx(TooltipContent, { side: "top", sideOffset: 8, children: _jsxs("div", { className: "text-xs", children: [_jsx("div", { children: entry.day }), _jsxs("div", { children: [segment.label, ": ", segment.value.toLocaleString(), " tokens"] })] }) })] }) }, segment.key)) : null) }) }) }), _jsx("span", { className: "text-center text-[11px] text-muted-foreground", children: entry.day.slice(5) })] }, entry.day));
                }) }), _jsxs("div", { className: "mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground", children: [_jsxs("span", { className: "inline-flex items-center gap-2", children: [_jsx("span", { className: "size-2 rounded-full bg-sky-500/80" }), "Input"] }), _jsxs("span", { className: "inline-flex items-center gap-2", children: [_jsx("span", { className: "size-2 rounded-full bg-emerald-500/80" }), "Output"] }), _jsxs("span", { className: "inline-flex items-center gap-2", children: [_jsx("span", { className: "size-2 rounded-full bg-amber-500/70" }), "Cache read"] }), _jsxs("span", { className: "inline-flex items-center gap-2", children: [_jsx("span", { className: "size-2 rounded-full bg-fuchsia-500/70" }), "Cache write"] })] })] }));
}
