import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: GeneralPane is the single owner of all general settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. */
import { useEffect, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { Download, FolderOpen, Loader2, Plus, RefreshCw, Timer, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { CliSection } from './CliSection';
import { toast } from 'sonner';
import { DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS, MAX_EDITOR_AUTO_SAVE_DELAY_MS, MIN_EDITOR_AUTO_SAVE_DELAY_MS } from '../../../../shared/constants';
import { clampNumber } from '@/lib/terminal-theme';
import { GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES, GENERAL_CACHE_TIMER_SEARCH_ENTRIES, GENERAL_CLI_SEARCH_ENTRIES, GENERAL_EDITOR_SEARCH_ENTRIES, GENERAL_PANE_SEARCH_ENTRIES, GENERAL_UPDATE_SEARCH_ENTRIES, GENERAL_WORKSPACE_SEARCH_ENTRIES } from './general-search';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { SearchableSetting } from './SearchableSetting';
import { matchesSettingsSearch } from './settings-search';
import { markLiveCodexSessionsForRestart } from '@/lib/codex-session-restart';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
export { GENERAL_PANE_SEARCH_ENTRIES };
function getCodexAccountLabel(state, accountId) {
    if (accountId == null) {
        return 'System default';
    }
    return state.accounts.find((account) => account.id === accountId)?.email ?? 'Codex account';
}
function getCodexAccountErrorDescription(error) {
    const message = String(error?.message ?? error)
        .replace(/^Error occurred in handler for 'codexAccounts:[^']+':\s*/i, '')
        .replace(/^Error invoking remote method 'codexAccounts:[^']+':\s*/i, '')
        .replace(/^Error:\s*/i, '')
        .trim();
    const normalizedMessage = message.toLowerCase();
    // Why: Codex account actions cross the Electron IPC boundary, and invoke()
    // failures often include transport-level wrapper text that is useful in
    // devtools but noisy in product UI. Normalize the handful of expected auth
    // failures here so users see actionable sign-in guidance instead of IPC
    // internals or raw upstream wording.
    if (normalizedMessage.includes('timed out waiting for codex login to finish')) {
        return 'Codex sign-in took too long to finish. Please try again.';
    }
    if (normalizedMessage.includes('codex sign-in took too long to finish')) {
        return 'Codex sign-in took too long to finish. Please try again.';
    }
    if (normalizedMessage.includes('auth error 502') ||
        normalizedMessage.includes('gateway') ||
        normalizedMessage.includes('bad gateway')) {
        return 'Codex sign-in is temporarily unavailable. Please try again in a minute.';
    }
    if (normalizedMessage.startsWith('codex login failed:')) {
        const loginMessage = message.slice('Codex login failed:'.length).trim();
        return loginMessage || 'Codex sign-in failed. Please try again.';
    }
    return message || 'Codex sign-in failed. Please try again.';
}
export function GeneralPane({ settings, updateSettings }) {
    const searchQuery = useAppStore((s) => s.settingsSearchQuery);
    const updateStatus = useAppStore((s) => s.updateStatus);
    const fetchSettings = useAppStore((s) => s.fetchSettings);
    const [appVersion, setAppVersion] = useState(null);
    const [autoSaveDelayDraft, setAutoSaveDelayDraft] = useState(String(settings.editorAutoSaveDelayMs));
    const [codexAccounts, setCodexAccounts] = useState({
        accounts: [],
        activeAccountId: null
    });
    const [codexAction, setCodexAction] = useState('idle');
    const [removeAccountId, setRemoveAccountId] = useState(null);
    useEffect(() => {
        window.api.updater.getVersion().then(setAppVersion);
    }, []);
    useEffect(() => {
        setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs));
    }, [settings.editorAutoSaveDelayMs]);
    useEffect(() => {
        let stale = false;
        const loadCodexAccounts = async () => {
            try {
                const next = await window.api.codexAccounts.list();
                if (!stale) {
                    setCodexAccounts(next);
                }
            }
            catch (error) {
                if (!stale) {
                    toast.error('Could not load Codex accounts.', {
                        description: String(error?.message ?? error)
                    });
                }
            }
        };
        void loadCodexAccounts();
        return () => {
            stale = true;
        };
    }, []);
    const handleBrowseWorkspace = async () => {
        const path = await window.api.repos.pickFolder();
        if (path) {
            updateSettings({ workspaceDir: path });
        }
    };
    const commitAutoSaveDelay = () => {
        const trimmed = autoSaveDelayDraft.trim();
        if (trimmed === '') {
            setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs));
            return;
        }
        const value = Number(trimmed);
        if (!Number.isFinite(value)) {
            setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs));
            return;
        }
        const next = clampNumber(Math.round(value), MIN_EDITOR_AUTO_SAVE_DELAY_MS, MAX_EDITOR_AUTO_SAVE_DELAY_MS);
        updateSettings({ editorAutoSaveDelayMs: next });
        setAutoSaveDelayDraft(String(next));
    };
    const handleRestartToUpdate = () => {
        // Why: quitAndInstall resolves immediately (the actual quit happens in a
        // deferred timer in the main process), so rejection here is only possible
        // if the IPC channel itself breaks. Log defensively; the user will notice
        // the app didn't restart and can retry.
        void window.api.updater.quitAndInstall().catch(console.error);
    };
    const syncCodexAccounts = async (next) => {
        setCodexAccounts(next);
        await fetchSettings();
    };
    const formatAccountTimestamp = (timestamp) => {
        return new Date(timestamp).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    };
    const runCodexAccountAction = async (action, operation) => {
        const previousActiveAccountId = codexAccounts.activeAccountId;
        setCodexAction(action);
        try {
            const next = await operation();
            await syncCodexAccounts(next);
            const shouldPromptRestart = action === 'adding' ||
                (action.startsWith('select:') && previousActiveAccountId !== next.activeAccountId) ||
                (action.startsWith('reauth:') &&
                    next.activeAccountId !== null &&
                    action === `reauth:${next.activeAccountId}`) ||
                (action.startsWith('remove:') && previousActiveAccountId !== next.activeAccountId);
            if (shouldPromptRestart) {
                void markLiveCodexSessionsForRestart({
                    previousAccountLabel: getCodexAccountLabel(codexAccounts, previousActiveAccountId),
                    nextAccountLabel: getCodexAccountLabel(next, next.activeAccountId)
                });
            }
        }
        catch (error) {
            toast.error('Codex account update failed.', {
                description: getCodexAccountErrorDescription(error)
            });
        }
        finally {
            setCodexAction('idle');
        }
    };
    const visibleSections = [
        matchesSettingsSearch(searchQuery, GENERAL_WORKSPACE_SEARCH_ENTRIES) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Workspace" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Configure where new worktrees are created." })] }), _jsxs(SearchableSetting, { title: "Workspace Directory", description: "Root directory where worktree folders are created.", keywords: ['workspace', 'folder', 'path', 'worktree'], className: "space-y-2", children: [_jsx(Label, { children: "Workspace Directory" }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { value: settings.workspaceDir, onChange: (e) => updateSettings({ workspaceDir: e.target.value }), className: "flex-1 text-xs" }), _jsxs(Button, { variant: "outline", size: "sm", onClick: handleBrowseWorkspace, className: "shrink-0 gap-1.5", children: [_jsx(FolderOpen, { className: "size-3.5" }), "Browse"] })] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Root directory where worktree folders are created." })] }), _jsxs(SearchableSetting, { title: "Nest Workspaces", description: "Create worktrees inside a repo-named subfolder.", keywords: ['nested', 'subfolder', 'directory'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Nest Workspaces" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Create worktrees inside a repo-named subfolder." })] }), _jsx("button", { role: "switch", "aria-checked": settings.nestWorkspaces, onClick: () => updateSettings({
                                nestWorkspaces: !settings.nestWorkspaces
                            }), className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.nestWorkspaces ? 'bg-foreground' : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${settings.nestWorkspaces ? 'translate-x-4' : 'translate-x-0.5'}` }) })] })] }, "workspace")) : null,
        matchesSettingsSearch(searchQuery, GENERAL_EDITOR_SEARCH_ENTRIES) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Editor" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Configure how Orca persists file edits." })] }), _jsxs(SearchableSetting, { title: "Auto Save Files", description: "Save editor and editable diff changes automatically after a short pause.", keywords: ['autosave', 'save'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Auto Save Files" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Save editor and editable diff changes automatically after a short pause." })] }), _jsx("button", { role: "switch", "aria-checked": settings.editorAutoSave, onClick: () => updateSettings({
                                editorAutoSave: !settings.editorAutoSave
                            }), className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.editorAutoSave ? 'bg-foreground' : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${settings.editorAutoSave ? 'translate-x-4' : 'translate-x-0.5'}` }) })] }), _jsxs(SearchableSetting, { title: "Auto Save Delay", description: "How long Orca waits after your last edit before saving automatically.", keywords: ['autosave', 'delay', 'milliseconds'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Auto Save Delay" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["How long Orca waits after your last edit before saving automatically. First launch defaults to ", DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS, " ms."] })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-2", children: [_jsx(Input, { type: "number", min: MIN_EDITOR_AUTO_SAVE_DELAY_MS, max: MAX_EDITOR_AUTO_SAVE_DELAY_MS, step: 250, value: autoSaveDelayDraft, onChange: (e) => setAutoSaveDelayDraft(e.target.value), onBlur: commitAutoSaveDelay, onKeyDown: (e) => {
                                        if (e.key === 'Enter') {
                                            commitAutoSaveDelay();
                                        }
                                    }, className: "number-input-clean w-28 text-right tabular-nums" }), _jsx("span", { className: "text-xs text-muted-foreground", children: "ms" })] })] }), _jsxs(SearchableSetting, { title: "Default Diff View", description: "Preferred presentation format for showing git diffs by default.", keywords: ['diff', 'view', 'inline', 'side-by-side', 'split'], className: "flex flex-col items-start gap-3 px-1 py-2 sm:flex-row sm:items-center sm:justify-between", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Default Diff View" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Preferred presentation format for showing git diffs by default." })] }), _jsx("div", { className: "flex shrink-0 items-center rounded-md border border-border/60 bg-background/50 p-0.5", children: ['inline', 'side-by-side'].map((option) => (_jsx("button", { onClick: () => updateSettings({ diffDefaultView: option }), className: `rounded-sm px-3 py-1 text-sm transition-colors ${settings.diffDefaultView === option
                                    ? 'bg-accent font-medium text-accent-foreground'
                                    : 'text-muted-foreground hover:text-foreground'}`, children: option === 'inline' ? 'Inline' : 'Side-by-side' }, option))) })] })] }, "editor")) : null,
        matchesSettingsSearch(searchQuery, GENERAL_CLI_SEARCH_ENTRIES) ? (_jsx(CliSection, { currentPlatform: navigator.userAgent.includes('Mac') ? 'darwin' : 'other' }, "cli")) : null,
        matchesSettingsSearch(searchQuery, GENERAL_CACHE_TIMER_SEARCH_ENTRIES) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Prompt Cache Timer" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Claude caches your conversation to reduce costs. When idle too long the cache expires and the next message resends full context at higher cost. This shows a countdown so you know when to resume." })] }), _jsxs(SearchableSetting, { title: "Cache Timer", description: "Show a countdown after a Claude agent becomes idle.", keywords: ['cache', 'timer', 'prompt', 'ttl', 'claude'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Timer, { className: "size-4" }), _jsx(Label, { children: "Cache Timer" })] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Show a countdown in the sidebar after a Claude agent becomes idle." })] }), _jsx("button", { role: "switch", "aria-checked": settings.promptCacheTimerEnabled, "aria-label": "Cache Timer", onClick: () => {
                                const enabling = !settings.promptCacheTimerEnabled;
                                updateSettings({ promptCacheTimerEnabled: enabling });
                                // Why: if enabling mid-session, seed timers for any Claude tabs that
                                // are already idle — their working→idle transition already happened
                                // and won't re-fire.
                                if (enabling) {
                                    useAppStore.getState().seedCacheTimersForIdleTabs();
                                }
                            }, className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.promptCacheTimerEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${settings.promptCacheTimerEnabled ? 'translate-x-4' : 'translate-x-0.5'}` }) })] }), settings.promptCacheTimerEnabled && (_jsxs(SearchableSetting, { title: "Timer Duration", description: "Match this to your provider's cache TTL.", keywords: ['cache', 'timer', 'duration', 'ttl'], className: "flex items-center justify-between gap-4 px-1 py-2 pl-7", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Timer Duration" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Match this to your provider's cache TTL. The default is 5 minutes." })] }), _jsxs(Select, { value: String(settings.promptCacheTtlMs), onValueChange: (v) => updateSettings({ promptCacheTtlMs: Number(v) }), children: [_jsx(SelectTrigger, { size: "sm", className: "h-7 text-xs w-[120px]", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "300000", children: "5 minutes" }), _jsx(SelectItem, { value: "3600000", children: "1 hour" })] })] })] }))] }, "cache-timer")) : null,
        matchesSettingsSearch(searchQuery, GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES) ? (_jsxs("section", { id: "general-codex-accounts", className: "space-y-4 scroll-mt-6", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Codex Accounts" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Add and switch between Codex accounts in Orca." }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Each account keeps its own local sign-in context in Orca. Account auth stays on this device." })] }), _jsxs(SearchableSetting, { title: "Codex Accounts", description: "Manage which Codex account Orca uses for live rate limit fetching.", keywords: ['codex', 'account', 'rate limit', 'status bar', 'quota'], className: "space-y-3 px-1 py-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Accounts" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Add a Codex account to use it in Orca." })] }), _jsxs(Button, { variant: "outline", size: "xs", onClick: () => void runCodexAccountAction('adding', () => window.api.codexAccounts.add()), disabled: codexAction !== 'idle', className: "gap-1.5", children: [codexAction === 'adding' ? (_jsx(Loader2, { className: "size-3 animate-spin" })) : (_jsx(Plus, { className: "size-3" })), "Add Account"] })] }), codexAccounts.accounts.length === 0 ? (_jsx("div", { className: "rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground", children: "No managed Codex accounts yet. Orca will use your system default Codex login until you add one here." })) : (_jsxs("div", { className: "space-y-2", children: [_jsx("button", { type: "button", onClick: () => void runCodexAccountAction('select:system', () => window.api.codexAccounts.select({ accountId: null })), disabled: codexAction !== 'idle', className: `flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${codexAccounts.activeAccountId === null
                                        ? 'border-foreground/20 bg-accent/15'
                                        : 'border-border/70 hover:border-border hover:bg-accent/8'} disabled:cursor-default disabled:opacity-100`, children: _jsxs("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: "System default" }), codexAccounts.activeAccountId === null ? (_jsx(Badge, { variant: "outline", className: "h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80", children: "Active" })) : null] }), _jsx("span", { className: "truncate text-[11px] text-muted-foreground", children: "Use your current system Codex login." })] }) }), codexAccounts.accounts.map((account) => {
                                    const isActive = codexAccounts.activeAccountId === account.id;
                                    const isReauthing = codexAction === `reauth:${account.id}`;
                                    const isRemoving = codexAction === `remove:${account.id}`;
                                    const isBusy = codexAction !== 'idle';
                                    return (_jsx("button", { type: "button", onClick: () => void runCodexAccountAction(`select:${account.id}`, () => window.api.codexAccounts.select({ accountId: account.id })), disabled: isBusy, className: `flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${isActive
                                            ? 'border-foreground/20 bg-accent/15'
                                            : 'border-border/70 hover:border-border hover:bg-accent/8'}`, children: _jsxs("div", { className: "flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start", children: [_jsxs("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: account.email }), isActive ? (_jsx(Badge, { variant: "outline", className: "h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80", children: "Active" })) : null] }), _jsxs("div", { className: "flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground max-sm:flex-wrap", children: [account.workspaceLabel ? (_jsx("span", { className: "truncate", children: account.workspaceLabel })) : null, account.workspaceLabel ? (_jsx("span", { className: "shrink-0 opacity-50", children: "\u2022" })) : null, _jsx("span", { className: "shrink-0", children: formatAccountTimestamp(account.lastAuthenticatedAt) })] })] }), _jsxs("div", { className: "flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap", children: [_jsxs(Button, { variant: "ghost", size: "xs", onClick: (event) => {
                                                                event.stopPropagation();
                                                                void runCodexAccountAction(`reauth:${account.id}`, () => window.api.codexAccounts.reauthenticate({ accountId: account.id }));
                                                            }, disabled: isBusy, className: "h-6 px-2 text-muted-foreground hover:text-foreground", children: [isReauthing ? (_jsx(Loader2, { className: "size-3 animate-spin" })) : (_jsx(RefreshCw, { className: "size-3" })), "Re-authenticate"] }), _jsxs(Button, { variant: "ghost", size: "xs", onClick: (event) => {
                                                                event.stopPropagation();
                                                                setRemoveAccountId(account.id);
                                                            }, disabled: isBusy, className: "h-6 px-2 text-muted-foreground hover:text-destructive", children: [isRemoving ? (_jsx(Loader2, { className: "size-3 animate-spin" })) : (_jsx(Trash2, { className: "size-3" })), "Remove"] })] })] }) }, account.id));
                                })] }))] })] }, "codex-accounts")) : null,
        matchesSettingsSearch(searchQuery, GENERAL_UPDATE_SEARCH_ENTRIES) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Updates" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Current version: ", appVersion ?? '…'] })] }), _jsxs(SearchableSetting, { title: "Check for Updates", description: "Check for app updates and install a newer Orca version.", keywords: ['update', 'version', 'release notes', 'download'], className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs(Button, { variant: "outline", size: "sm", onClick: () => window.api.updater.check(), disabled: updateStatus.state === 'checking' || updateStatus.state === 'downloading', className: "gap-2", children: [updateStatus.state === 'checking' ? (_jsx(Loader2, { className: "size-3.5 animate-spin" })) : (_jsx(RefreshCw, { className: "size-3.5" })), "Check for Updates"] }), updateStatus.state === 'available' ? (_jsxs(Button, { variant: "default", size: "sm", onClick: () => {
                                        void window.api.updater.download().catch((error) => {
                                            toast.error('Could not start the update download.', {
                                                description: String(error?.message ?? error)
                                            });
                                        });
                                    }, className: "gap-2", children: [_jsx(Download, { className: "size-3.5" }), "Install Update (", updateStatus.version, ")"] })) : updateStatus.state === 'downloaded' ? (_jsxs(Button, { variant: "default", size: "sm", onClick: handleRestartToUpdate, className: "gap-2", children: [_jsx(Download, { className: "size-3.5" }), "Restart to Update (", updateStatus.version, ")"] })) : null] }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [updateStatus.state === 'idle' && 'Updates are checked automatically on launch.', updateStatus.state === 'checking' && 'Checking for updates...', updateStatus.state === 'available' && (_jsxs(_Fragment, { children: ["Version ", updateStatus.version, " is available. Click \"Install Update\" to download and install it.", ' ', _jsx("a", { href: updateStatus.releaseUrl ??
                                                `https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`, target: "_blank", rel: "noopener noreferrer", className: "underline hover:text-foreground", children: "Release notes" })] })), updateStatus.state === 'not-available' && 'You\u2019re on the latest version.', updateStatus.state === 'downloading' &&
                                    `Downloading v${updateStatus.version}... ${updateStatus.percent}%`, updateStatus.state === 'downloaded' && (_jsxs(_Fragment, { children: ["Version ", updateStatus.version, " is ready to install.", ' ', _jsx("a", { href: updateStatus.releaseUrl ??
                                                `https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`, target: "_blank", rel: "noopener noreferrer", className: "underline hover:text-foreground", children: "Release notes" })] })), updateStatus.state === 'error' && `Update error: ${updateStatus.message}`] })] })] }, "updates")) : null
    ].filter(Boolean);
    return (_jsxs("div", { className: "space-y-8", children: [_jsx(Dialog, { open: removeAccountId !== null, onOpenChange: (open) => !open && setRemoveAccountId(null), children: _jsxs(DialogContent, { showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Remove Codex Account?" }), _jsx(DialogDescription, { children: "Orca will delete the managed Codex home for this saved account. If it is currently active, Orca falls back to the system default Codex login." })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => setRemoveAccountId(null), children: "Cancel" }), _jsx(Button, { variant: "destructive", onClick: () => {
                                        const accountId = removeAccountId;
                                        if (!accountId) {
                                            return;
                                        }
                                        setRemoveAccountId(null);
                                        void runCodexAccountAction(`remove:${accountId}`, () => window.api.codexAccounts.remove({ accountId }));
                                    }, children: "Remove Account" })] })] }) }), visibleSections.map((section, index) => (_jsxs("div", { className: "space-y-8", children: [index > 0 ? _jsx(Separator, {}) : null, section] }, index)))] }));
}
