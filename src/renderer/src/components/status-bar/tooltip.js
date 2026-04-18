import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ClaudeIcon, OpenAIIcon } from './icons';
// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
export function formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000) {
        return 'just now';
    }
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) {
        return `${mins}m ago`;
    }
    const hours = Math.floor(mins / 60);
    return `${hours}h ago`;
}
function formatDuration(ms) {
    if (ms <= 0) {
        return 'now';
    }
    const totalMins = Math.floor(ms / 60_000);
    if (totalMins < 60) {
        return `${totalMins}m`;
    }
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
    }
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
// ---------------------------------------------------------------------------
// Shared icon component
// ---------------------------------------------------------------------------
export function ProviderIcon({ provider }) {
    if (provider === 'codex') {
        return _jsx(OpenAIIcon, { size: 13 });
    }
    return _jsx(ClaudeIcon, { size: 13 });
}
function ErrorMessage({ message, inverted = false }) {
    const labelClass = inverted ? 'text-background/80' : 'text-foreground/85';
    const detailClass = inverted ? 'text-background/55' : 'text-muted-foreground';
    return (_jsxs("div", { className: "space-y-0.5", children: [_jsx("div", { className: `text-[11px] font-medium ${labelClass}`, children: "Usage unavailable" }), _jsx("div", { className: detailClass, children: message })] }));
}
// ---------------------------------------------------------------------------
// Tooltip — progress bar section for a single window
// ---------------------------------------------------------------------------
// Why: the base tooltip component uses `bg-foreground text-background` which
// inverts the color scheme (light bg in dark mode). These rich tooltips use
// `text-background` for primary text and `text-background/50` for secondary
// to stay readable inside the inverted tooltip container.
// Why: color-coded by remaining capacity so users can quickly gauge urgency.
// Green = comfortable (>40% left), yellow = caution (20-40%), red = critical (<20%).
function barColor(leftPct) {
    if (leftPct > 40) {
        return 'bg-green-500';
    }
    if (leftPct > 20) {
        return 'bg-yellow-500';
    }
    return 'bg-red-500';
}
function TooltipWindowSection({ w, label }) {
    if (!w) {
        return null;
    }
    const leftPct = Math.max(0, Math.round(100 - w.usedPercent));
    const resetIn = w.resetsAt ? formatDuration(w.resetsAt - Date.now()) : null;
    return (_jsxs("div", { className: "space-y-1", children: [_jsx("div", { className: "font-medium text-background", children: label }), _jsx("div", { className: "w-full h-[6px] rounded-full bg-background/20 overflow-hidden", children: _jsx("div", { className: `h-full rounded-full ${barColor(leftPct)} transition-all duration-300`, style: { width: `${Math.min(100, Math.max(0, leftPct))}%` } }) }), _jsxs("div", { className: "flex justify-between text-background/60", children: [_jsxs("span", { children: [leftPct, "% left"] }), resetIn && _jsxs("span", { children: ["Resets in ", resetIn] })] })] }));
}
// ---------------------------------------------------------------------------
// Tooltip content
// ---------------------------------------------------------------------------
export function ProviderTooltip({ p }) {
    if (!p) {
        return _jsx("span", { className: "text-xs text-background/60", children: "No data available" });
    }
    const name = p.provider === 'claude' ? 'Claude' : 'Codex';
    if (p.status === 'unavailable') {
        return (_jsxs("div", { className: "text-xs w-[200px]", children: [_jsxs("div", { className: "flex items-center gap-1.5 font-medium text-background", children: [_jsx(ProviderIcon, { provider: p.provider }), name] }), _jsx("div", { className: "text-background/60", children: p.error ?? 'CLI not found' })] }));
    }
    if (p.status === 'error' && !p.session && !p.weekly) {
        return (_jsxs("div", { className: "text-xs w-[200px]", children: [_jsxs("div", { className: "flex items-center gap-1.5 font-medium text-background", children: [_jsx(ProviderIcon, { provider: p.provider }), name] }), _jsx("div", { className: "text-background/60", children: p.error ?? 'Unable to fetch usage' })] }));
    }
    const updatedAgo = p.updatedAt ? `Updated ${formatTimeAgo(p.updatedAt)}` : 'Not yet updated';
    return (_jsxs("div", { className: "text-xs w-[200px] space-y-3", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-1.5 font-medium text-background text-[13px]", children: [_jsx(ProviderIcon, { provider: p.provider }), name] }), _jsx("div", { className: "text-background/50", children: updatedAgo })] }), _jsx("div", { className: "border-t border-background/15" }), _jsx(TooltipWindowSection, { w: p.session, label: "Session" }), _jsx(TooltipWindowSection, { w: p.weekly, label: "Weekly" }), p.error ? _jsx(ErrorMessage, { message: p.error, inverted: true }) : null] }));
}
export function ProviderPanel({ p, inverted = false, className }) {
    const textClass = inverted ? 'text-background' : 'text-foreground';
    const mutedClass = inverted ? 'text-background/60' : 'text-muted-foreground';
    const faintClass = inverted ? 'text-background/50' : 'text-muted-foreground/80';
    const dividerClass = inverted ? 'border-background/15' : 'border-border/70';
    const emptyBarClass = inverted ? 'bg-background/20' : 'bg-muted';
    if (!p) {
        return _jsx("span", { className: `text-xs ${mutedClass}`, children: "No data available" });
    }
    const name = p.provider === 'claude' ? 'Claude' : 'Codex';
    if (p.status === 'unavailable') {
        return (_jsxs("div", { className: `text-xs ${className ?? 'w-full'}`, children: [_jsxs("div", { className: `flex items-center gap-1.5 font-medium ${textClass}`, children: [_jsx(ProviderIcon, { provider: p.provider }), name] }), _jsx("div", { className: mutedClass, children: p.error ?? 'CLI not found' })] }));
    }
    if (p.status === 'error' && !p.session && !p.weekly) {
        return (_jsxs("div", { className: `text-xs ${className ?? 'w-full'}`, children: [_jsxs("div", { className: `flex items-center gap-1.5 font-medium ${textClass}`, children: [_jsx(ProviderIcon, { provider: p.provider }), name] }), _jsx("div", { className: "mt-2", children: _jsx(ErrorMessage, { message: p.error ?? 'Unable to fetch usage', inverted: inverted }) })] }));
    }
    const updatedAgo = p.updatedAt ? `Updated ${formatTimeAgo(p.updatedAt)}` : 'Not yet updated';
    const PanelWindowSection = ({ w, label }) => {
        if (!w) {
            return null;
        }
        const leftPct = Math.max(0, Math.round(100 - w.usedPercent));
        const resetIn = w.resetsAt ? formatDuration(w.resetsAt - Date.now()) : null;
        return (_jsxs("div", { className: "space-y-1", children: [_jsx("div", { className: `font-medium ${textClass}`, children: label }), _jsx("div", { className: `h-[6px] w-full overflow-hidden rounded-full ${emptyBarClass}`, children: _jsx("div", { className: `h-full rounded-full ${barColor(leftPct)} transition-all duration-300`, style: { width: `${Math.min(100, Math.max(0, leftPct))}%` } }) }), _jsxs("div", { className: `flex justify-between ${mutedClass}`, children: [_jsxs("span", { children: [leftPct, "% left"] }), resetIn && _jsxs("span", { children: ["Resets in ", resetIn] })] })] }));
    };
    return (_jsxs("div", { className: `${className ?? 'w-full'} space-y-3 text-xs`, children: [_jsxs("div", { children: [_jsxs("div", { className: `flex items-center gap-1.5 text-[13px] font-medium ${textClass}`, children: [_jsx(ProviderIcon, { provider: p.provider }), name] }), _jsx("div", { className: faintClass, children: updatedAgo })] }), _jsx("div", { className: `border-t ${dividerClass}` }), _jsx(PanelWindowSection, { w: p.session, label: "Session" }), _jsx(PanelWindowSection, { w: p.weekly, label: "Weekly" }), p.error ? _jsx(ErrorMessage, { message: p.error, inverted: inverted }) : null] }));
}
