import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Terminal } from 'lucide-react';
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '@/lib/utils';
export { AGENTS_PANE_SEARCH_ENTRIES } from './agents-search';
function AgentRow({ agentId, label, homepageUrl, defaultCmd, isDetected, isDefault, cmdOverride, onSetDefault, onSaveOverride }) {
    const [cmdOpen, setCmdOpen] = useState(Boolean(cmdOverride));
    const [cmdDraft, setCmdDraft] = useState(cmdOverride ?? defaultCmd);
    useEffect(() => {
        setCmdDraft(cmdOverride ?? defaultCmd);
    }, [cmdOverride, defaultCmd]);
    const commitCmd = () => {
        const trimmed = cmdDraft.trim();
        if (!trimmed || trimmed === defaultCmd) {
            onSaveOverride('');
            setCmdDraft(defaultCmd);
        }
        else {
            onSaveOverride(trimmed);
        }
    };
    return (_jsxs("div", { className: cn('group rounded-xl border transition-all', isDetected ? 'border-border/60 bg-card/60' : 'border-border/30 bg-card/20 opacity-60'), children: [_jsxs("div", { className: "flex items-center gap-3 px-4 py-3", children: [_jsx("div", { className: "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/60", children: _jsx(AgentIcon, { agent: agentId, size: 18 }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-sm font-semibold leading-none", children: label }), isDetected ? (_jsxs("span", { className: "inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300", children: [_jsx("span", { className: "size-1.5 rounded-full bg-emerald-500" }), "Detected"] })) : (_jsx("span", { className: "inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground", children: "Not installed" }))] }), _jsx("div", { className: "mt-0.5 font-mono text-[11px] text-muted-foreground", children: cmdOverride ? (_jsxs("span", { children: [_jsx("span", { className: "text-muted-foreground/60 line-through", children: defaultCmd }), _jsx("span", { className: "ml-1.5 text-foreground/70", children: cmdOverride })] })) : (defaultCmd) })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1", children: [isDetected && (_jsxs("button", { type: "button", onClick: onSetDefault, title: isDefault ? 'Default agent' : 'Set as default', className: cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors', isDefault
                                    ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'), children: [isDefault && _jsx(Check, { className: "size-3" }), isDefault ? 'Default' : 'Set default'] })), isDetected && (_jsx("button", { type: "button", onClick: () => setCmdOpen((prev) => !prev), title: "Customize command", className: cn('flex size-7 items-center justify-center rounded-lg transition-colors', cmdOpen || cmdOverride
                                    ? 'bg-muted/60 text-foreground'
                                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'), children: _jsx(Terminal, { className: "size-3.5" }) })), _jsx("a", { href: homepageUrl, target: "_blank", rel: "noopener noreferrer", title: isDetected ? 'Docs' : 'Install', className: "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground", children: _jsx(ExternalLink, { className: "size-3.5" }) }), isDetected && (_jsx("button", { type: "button", onClick: () => setCmdOpen((prev) => !prev), className: "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground", children: _jsx(ChevronDown, { className: cn('size-3.5 transition-transform', cmdOpen && 'rotate-180') }) }))] })] }), isDetected && cmdOpen && (_jsxs("div", { className: "border-t border-border/40 px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "shrink-0 text-xs text-muted-foreground", children: "Command" }), _jsx(Input, { value: cmdDraft, onChange: (e) => setCmdDraft(e.target.value), onBlur: commitCmd, onKeyDown: (e) => {
                                    if (e.key === 'Enter') {
                                        commitCmd();
                                        e.currentTarget.blur();
                                    }
                                    if (e.key === 'Escape') {
                                        setCmdDraft(cmdOverride ?? defaultCmd);
                                        e.currentTarget.blur();
                                    }
                                }, placeholder: defaultCmd, spellCheck: false, className: "h-7 flex-1 font-mono text-xs" }), cmdOverride && (_jsx(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => {
                                    onSaveOverride('');
                                    setCmdDraft(defaultCmd);
                                }, className: "h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground", children: "Reset" }))] }), _jsx("p", { className: "mt-1.5 text-[11px] text-muted-foreground", children: "Override the binary path or name used to launch this agent." })] }))] }));
}
export function AgentsPane({ settings, updateSettings }) {
    const [detectedIds, setDetectedIds] = useState(null);
    useEffect(() => {
        void window.api.preflight.detectAgents().then((ids) => {
            setDetectedIds(new Set(ids));
        });
    }, []);
    const defaultAgent = settings.defaultTuiAgent;
    const cmdOverrides = settings.agentCmdOverrides ?? {};
    const setDefault = (id) => {
        updateSettings({ defaultTuiAgent: id });
    };
    const saveOverride = (id, value) => {
        const next = { ...cmdOverrides };
        if (value) {
            next[id] = value;
        }
        else {
            delete next[id];
        }
        updateSettings({ agentCmdOverrides: next });
    };
    const detectedAgents = AGENT_CATALOG.filter((a) => detectedIds === null || detectedIds.has(a.id));
    const undetectedAgents = AGENT_CATALOG.filter((a) => detectedIds !== null && !detectedIds.has(a.id));
    const isAutoDefault = defaultAgent === null || !detectedIds?.has(defaultAgent);
    return (_jsxs("div", { className: "space-y-8", children: [_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Default Agent" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Pre-selected agent when opening a new workspace. Set to Auto to use the first detected agent." })] }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsxs("button", { type: "button", onClick: () => setDefault(null), className: cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all', isAutoDefault
                                    ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                                    : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'), children: [isAutoDefault && _jsx(Check, { className: "size-3.5" }), "Auto"] }), detectedAgents.map((agent) => {
                                const isActive = defaultAgent === agent.id;
                                return (_jsxs("button", { type: "button", onClick: () => setDefault(agent.id), className: cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all', isActive
                                        ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                                        : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'), children: [_jsx(AgentIcon, { agent: agent.id, size: 14 }), agent.label, isActive && _jsx(Check, { className: "size-3.5" })] }, agent.id));
                            })] })] }), detectedAgents.length > 0 && (_jsxs("section", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Installed" }), _jsxs("span", { className: "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300", children: [detectedAgents.length, " detected"] })] }), _jsx("div", { className: "space-y-2", children: detectedAgents.map((agent) => (_jsx(AgentRow, { agentId: agent.id, label: agent.label, homepageUrl: agent.homepageUrl, defaultCmd: agent.cmd, isDetected: true, isDefault: defaultAgent === agent.id, cmdOverride: cmdOverrides[agent.id], onSetDefault: () => setDefault(agent.id), onSaveOverride: (v) => saveOverride(agent.id, v) }, agent.id))) })] })), undetectedAgents.length > 0 && (_jsxs("section", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("h3", { className: "text-sm font-semibold text-muted-foreground", children: "Available to install" }), _jsxs("span", { className: "rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground", children: [undetectedAgents.length, " agents"] })] }), _jsx("div", { className: "space-y-2", children: undetectedAgents.map((agent) => (_jsx(AgentRow, { agentId: agent.id, label: agent.label, homepageUrl: agent.homepageUrl, defaultCmd: agent.cmd, isDetected: false, isDefault: false, cmdOverride: undefined, onSetDefault: () => { }, onSaveOverride: () => { } }, agent.id))) })] })), detectedIds === null && (_jsx("div", { className: "flex items-center justify-center rounded-xl border border-dashed border-border/50 py-8 text-sm text-muted-foreground", children: "Detecting installed agents\u2026" }))] }));
}
