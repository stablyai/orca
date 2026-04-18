import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: the status bar keeps provider rendering,
interaction menus, and compact-layout behavior together so the hover/click
states stay consistent across Claude and Codex. */
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAppStore } from '../../store';
import { ProviderIcon, ProviderPanel } from './tooltip';
import { markLiveCodexSessionsForRestart } from '@/lib/codex-session-restart';
import { SshStatusSegment } from './SshStatusSegment';
import { SessionsStatusSegment } from './SessionsStatusSegment';
function getCodexAccountLabel(state, accountId) {
    if (accountId == null) {
        return 'System default';
    }
    return state.accounts.find((account) => account.id === accountId)?.email ?? 'Codex account';
}
// ---------------------------------------------------------------------------
// Mini progress bar (shows remaining capacity, grey)
// ---------------------------------------------------------------------------
function MiniBar({ leftPct }) {
    return (_jsx("div", { className: "w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0", children: _jsx("div", { className: "h-full rounded-full transition-all duration-300 bg-muted-foreground/40", style: { width: `${Math.min(100, Math.max(0, leftPct))}%` } }) }));
}
// ---------------------------------------------------------------------------
// Window label (shows percent remaining)
// ---------------------------------------------------------------------------
function WindowLabel({ w, label }) {
    const left = Math.max(0, Math.round(100 - w.usedPercent));
    return (_jsxs("span", { className: "tabular-nums", children: [left, "% ", label] }));
}
// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------
function ProviderSegment({ p, compact }) {
    const provider = p?.provider ?? 'claude';
    const statusLabel = p?.error && /rate limit/i.test(p.error) ? 'Limited' : 'Unavailable';
    // Idle / initial load
    if (!p || p.status === 'idle') {
        return (_jsxs("span", { className: "inline-flex items-center gap-1 text-muted-foreground", children: [_jsx(ProviderIcon, { provider: provider }), _jsx("span", { className: "animate-pulse", children: "\u00B7\u00B7\u00B7" })] }));
    }
    // Fetching with no prior data
    if (p.status === 'fetching' && !p.session && !p.weekly) {
        return (_jsxs("span", { className: "inline-flex items-center gap-1 text-muted-foreground", children: [_jsx(ProviderIcon, { provider: provider }), _jsx("span", { className: "animate-pulse", children: "\u00B7\u00B7\u00B7" })] }));
    }
    // Unavailable (CLI not installed)
    if (p.status === 'unavailable') {
        return (_jsxs("span", { className: "inline-flex items-center gap-1 text-muted-foreground/50", children: [_jsx(ProviderIcon, { provider: provider }), " --"] }));
    }
    // Error with no data
    if (p.status === 'error' && !p.session && !p.weekly) {
        return (_jsxs("span", { className: "inline-flex items-center gap-1 text-muted-foreground", children: [_jsx(ProviderIcon, { provider: provider }), _jsx(AlertTriangle, { size: 11, className: "text-muted-foreground/80" }), !compact && _jsx("span", { className: "text-[11px] font-medium", children: statusLabel })] }));
    }
    // Has data (ok, fetching with stale data, or error with stale data)
    const isStale = p.status === 'error';
    return (_jsxs("span", { className: "inline-flex items-center gap-1.5", children: [_jsx(ProviderIcon, { provider: provider }), p.session && !compact && _jsx(MiniBar, { leftPct: Math.max(0, 100 - p.session.usedPercent) }), p.session && _jsx(WindowLabel, { w: p.session, label: "5h" }), p.session && p.weekly && _jsx("span", { className: "text-muted-foreground", children: "\u00B7" }), p.weekly && _jsx(WindowLabel, { w: p.weekly, label: "wk" }), isStale && _jsx(AlertTriangle, { size: 11, className: "text-muted-foreground/80" })] }));
}
function CodexSwitcherMenu({ codex, compact, iconOnly }) {
    const [open, setOpen] = useState(false);
    const [accountsExpanded, setAccountsExpanded] = useState(false);
    const [accounts, setAccounts] = useState({
        accounts: [],
        activeAccountId: null
    });
    const [isSwitching, setIsSwitching] = useState(false);
    const openSettingsPage = useAppStore((s) => s.openSettingsPage);
    const openSettingsTarget = useAppStore((s) => s.openSettingsTarget);
    const fetchSettings = useAppStore((s) => s.fetchSettings);
    const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
    const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId);
    const codexRestartNoticeByPtyId = useAppStore((s) => s.codexRestartNoticeByPtyId);
    const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts);
    const codexAccountSyncKey = useAppStore((s) => {
        const settings = s.settings;
        if (!settings) {
            return 'no-settings';
        }
        return `${settings.activeCodexManagedAccountId ?? 'system'}:${settings.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`;
    });
    const loadAccounts = useCallback(async () => {
        const next = await window.api.codexAccounts.list();
        setAccounts(next);
    }, []);
    useEffect(() => {
        // Why: the status bar keeps its own lightweight account snapshot for the
        // dropdown. Settings account actions mutate the main-process store outside
        // this component, so we refresh when the persisted account roster changes
        // or when the menu opens instead of leaving a stale account list mounted.
        void loadAccounts().catch((error) => {
            console.error('Failed to load Codex accounts for status bar:', error);
        });
    }, [loadAccounts, open, codexAccountSyncKey]);
    const handleSelectAccount = async (accountId) => {
        if (isSwitching) {
            return;
        }
        const previousActiveAccountId = accounts.activeAccountId;
        setIsSwitching(true);
        try {
            const next = await window.api.codexAccounts.select({ accountId });
            setAccounts(next);
            await fetchSettings();
            if (previousActiveAccountId !== next.activeAccountId) {
                await markLiveCodexSessionsForRestart({
                    previousAccountLabel: getCodexAccountLabel(accounts, previousActiveAccountId),
                    nextAccountLabel: getCodexAccountLabel(next, next.activeAccountId)
                });
                // Why: account switching can require a second explicit recovery step
                // for live Codex terminals. Keeping the switcher open and collapsing
                // back to the summary row lets the follow-up "restart open tabs"
                // prompt appear in the same flow instead of feeling detached.
                setAccountsExpanded(false);
            }
        }
        catch (error) {
            console.error('Failed to switch Codex account from status bar:', error);
        }
        finally {
            setIsSwitching(false);
        }
    };
    useEffect(() => {
        if (!open) {
            setAccountsExpanded(false);
        }
    }, [open]);
    const activeAccountLabel = accounts.activeAccountId === null
        ? 'System default'
        : (accounts.accounts.find((account) => account.id === accounts.activeAccountId)?.email ??
            'Managed');
    const availableSwitchTargets = [
        ...(accounts.activeAccountId === null
            ? []
            : [{ id: null, label: 'System default' }]),
        ...accounts.accounts
            .filter((account) => account.id !== accounts.activeAccountId)
            .map((account) => ({
            id: account.id,
            label: account.workspaceLabel
                ? `${account.email} (${account.workspaceLabel})`
                : account.email
        }))
    ];
    const staleCodexPtyIds = Object.keys(codexRestartNoticeByPtyId);
    const staleCodexTabIds = Object.keys(ptyIdsByTabId).filter((tabId) => (ptyIdsByTabId[tabId] ?? []).some((ptyId) => Boolean(codexRestartNoticeByPtyId[ptyId])));
    const staleCodexWorktreeCount = new Set(Object.entries(tabsByWorktree).flatMap(([worktreeId, tabs]) => tabs.some((tab) => staleCodexTabIds.includes(tab.id)) ? [worktreeId] : [])).size;
    const staleCodexSessionCount = staleCodexPtyIds.length;
    const staleCodexTabCount = staleCodexTabIds.length;
    return (_jsxs(ProviderDetailsMenu, { provider: codex, compact: compact, iconOnly: iconOnly, ariaLabel: "Open Codex details and account switcher", open: open, onOpenChange: setOpen, children: [_jsx(DropdownMenuLabel, { children: "Codex Account" }), _jsxs(DropdownMenuItem, { onSelect: (event) => {
                    event.preventDefault();
                    setAccountsExpanded((prev) => !prev);
                }, children: [_jsx("span", { className: "max-w-[180px] truncate text-[12px] text-foreground", children: activeAccountLabel }), accountsExpanded ? (_jsx(ChevronDown, { className: "ml-auto size-3.5 text-muted-foreground/85" })) : (_jsx(ChevronRight, { className: "ml-auto size-3.5 text-muted-foreground/85" }))] }), accountsExpanded ? (_jsxs("div", { className: "px-1 pb-1", children: [_jsx("div", { className: "px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground", children: "Switch to" }), _jsxs("div", { className: "max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1", children: [availableSwitchTargets.length === 0 ? (_jsx("div", { className: "px-2 py-1.5 text-[11px] text-muted-foreground", children: "No other accounts" })) : null, availableSwitchTargets.map((target) => (_jsx(DropdownMenuItem, { onSelect: (event) => {
                                    // Why: account switching may need an immediate follow-up
                                    // restart action for live Codex tabs. Prevent the menu from
                                    // auto-closing so that prompt can stay within the same
                                    // account-switcher interaction instead of jumping elsewhere.
                                    event.preventDefault();
                                    void handleSelectAccount(target.id);
                                }, disabled: isSwitching, children: _jsx("span", { className: "truncate", children: target.label }) }, target.id ?? 'system')))] })] })) : null, staleCodexTabCount > 0 ? (_jsxs(_Fragment, { children: [_jsx(DropdownMenuSeparator, {}), _jsxs("div", { className: "px-2 py-2", children: [_jsxs("div", { className: "text-[11px] text-muted-foreground", children: [staleCodexSessionCount === 1
                                        ? '1 Codex session is still on the old account'
                                        : `${staleCodexSessionCount} Codex sessions are still on the old account.`, staleCodexWorktreeCount > 1 ? (_jsx("span", { className: "mt-0.5 block", children: "Visible sessions restart now. Others restart when their worktree becomes active." })) : null] }), _jsx("button", { type: "button", onClick: () => queueCodexPaneRestarts(staleCodexPtyIds), className: "mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60", children: staleCodexSessionCount === 1
                                    ? 'Restart Session'
                                    : `Restart ${staleCodexSessionCount} Sessions` })] })] })) : null, _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuItem, { onSelect: () => {
                    openSettingsTarget({
                        pane: 'general',
                        repoId: null,
                        sectionId: 'general-codex-accounts'
                    });
                    openSettingsPage();
                }, children: "Manage Accounts\u2026" })] }));
}
function ProviderDetailsMenu({ provider, compact, iconOnly, ariaLabel, open, onOpenChange, children }) {
    return (_jsxs(DropdownMenu, { open: open, onOpenChange: onOpenChange, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { type: "button", className: "inline-flex items-center cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70", "aria-label": ariaLabel, children: iconOnly ? (_jsxs("span", { className: "inline-flex items-center gap-1", children: [_jsx("span", { className: `inline-block h-2 w-2 rounded-full ${provider.session || provider.weekly ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}` }), _jsx("span", { className: "text-muted-foreground", children: provider.provider === 'claude' ? 'C' : 'X' })] })) : (_jsx(ProviderSegment, { p: provider, compact: compact })) }) }), _jsxs(DropdownMenuContent, { side: "top", align: "start", sideOffset: 8, className: "w-[260px]", children: [_jsx("div", { className: "p-2", children: _jsx(ProviderPanel, { p: provider }) }), children ? (_jsxs(_Fragment, { children: [_jsx(DropdownMenuSeparator, {}), children] })) : null] })] }));
}
// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------
function StatusBarInner() {
    const rateLimits = useAppStore((s) => s.rateLimits);
    const refreshRateLimits = useAppStore((s) => s.refreshRateLimits);
    const statusBarVisible = useAppStore((s) => s.statusBarVisible);
    const statusBarItems = useAppStore((s) => s.statusBarItems);
    const toggleStatusBarItem = useAppStore((s) => s.toggleStatusBarItem);
    const containerRef = useRef(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [containerWidth, setContainerWidth] = useState(900);
    const resizeObserverRef = useRef(null);
    const containerRefCallback = useCallback((node) => {
        if (resizeObserverRef.current) {
            resizeObserverRef.current.disconnect();
            resizeObserverRef.current = null;
        }
        if (node) {
            containerRef.current = node;
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    setContainerWidth(entry.contentRect.width);
                }
            });
            observer.observe(node);
            resizeObserverRef.current = observer;
            setContainerWidth(node.getBoundingClientRect().width);
        }
    }, []);
    const handleRefresh = useCallback(async () => {
        if (isRefreshing) {
            return;
        }
        setIsRefreshing(true);
        try {
            await refreshRateLimits();
        }
        finally {
            setIsRefreshing(false);
        }
    }, [isRefreshing, refreshRateLimits]);
    if (!statusBarVisible) {
        return null;
    }
    const { claude, codex } = rateLimits;
    // Why: hiding `unavailable` providers makes the status bar appear to lose a
    // provider at random after refreshes or wake/resume. Keeping the slot visible
    // preserves layout stability and makes it obvious that the provider is still
    // configured but currently unavailable.
    const showClaude = claude && statusBarItems.includes('claude');
    const showCodex = codex && statusBarItems.includes('codex');
    const showSsh = statusBarItems.includes('ssh');
    const showSessions = statusBarItems.includes('sessions');
    const anyVisible = showClaude || showCodex;
    const anyFetching = claude?.status === 'fetching' || codex?.status === 'fetching';
    const compact = containerWidth < 900;
    const iconOnly = containerWidth < 500;
    return (_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsxs("div", { ref: containerRefCallback, className: "flex items-center h-6 min-h-[24px] px-3 gap-4 border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0", children: [_jsxs("div", { className: "flex items-center gap-3", children: [showClaude && (_jsx(ProviderDetailsMenu, { provider: claude, compact: compact, iconOnly: iconOnly, ariaLabel: "Open Claude usage details" })), showCodex && _jsx(CodexSwitcherMenu, { codex: codex, compact: compact, iconOnly: iconOnly }), anyVisible && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { onClick: handleRefresh, disabled: isRefreshing, className: "p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40", "aria-label": "Refresh rate limits", children: _jsx(RefreshCw, { size: 11, className: isRefreshing || anyFetching ? 'animate-spin' : '' }) }) }), _jsx(TooltipContent, { side: "top", sideOffset: 6, children: "Refresh usage data" })] }))] }), _jsx("div", { className: "flex-1" }), _jsxs("div", { className: "flex items-center gap-3", children: [showSessions && _jsx(SessionsStatusSegment, { compact: compact, iconOnly: iconOnly }), showSsh && _jsx(SshStatusSegment, { compact: compact, iconOnly: iconOnly })] })] }) }), _jsxs(ContextMenuContent, { className: "min-w-0 w-fit", children: [_jsx(ContextMenuCheckboxItem, { checked: statusBarItems.includes('claude'), onCheckedChange: () => toggleStatusBarItem('claude'), children: "Claude Usage" }), _jsx(ContextMenuCheckboxItem, { checked: statusBarItems.includes('codex'), onCheckedChange: () => toggleStatusBarItem('codex'), children: "Codex Usage" }), _jsx(ContextMenuCheckboxItem, { checked: statusBarItems.includes('ssh'), onCheckedChange: () => toggleStatusBarItem('ssh'), children: "SSH Status" }), _jsx(ContextMenuCheckboxItem, { checked: statusBarItems.includes('sessions'), onCheckedChange: () => toggleStatusBarItem('sessions'), children: "Terminal Sessions" })] })] }));
}
export const StatusBar = React.memo(StatusBarInner);
