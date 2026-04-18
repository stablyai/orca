import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Import, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useAppStore } from '../../store';
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants';
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url';
import { SearchableSetting } from './SearchableSetting';
import { matchesSettingsSearch } from './settings-search';
import { BROWSER_PANE_SEARCH_ENTRIES } from './browser-search';
export { BROWSER_PANE_SEARCH_ENTRIES };
export function BrowserPane({ settings, updateSettings }) {
    const searchQuery = useAppStore((s) => s.settingsSearchQuery);
    const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl);
    const setBrowserDefaultUrl = useAppStore((s) => s.setBrowserDefaultUrl);
    const detectedBrowsers = useAppStore((s) => s.detectedBrowsers);
    const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles);
    const browserSessionImportState = useAppStore((s) => s.browserSessionImportState);
    const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default');
    const orphanedProfiles = browserSessionProfiles.filter((p) => p.scope !== 'default');
    const [homePageDraft, setHomePageDraft] = useState(browserDefaultUrl ?? '');
    // Why: sync draft with store value whenever it changes externally (e.g. the
    // in-app browser tab's address bar saves a home page). Without this, the
    // settings field would show stale text after another surface wrote the value.
    useEffect(() => {
        setHomePageDraft(browserDefaultUrl ?? '');
    }, [browserDefaultUrl]);
    const showHomePage = matchesSettingsSearch(searchQuery, [BROWSER_PANE_SEARCH_ENTRIES[0]]);
    const showLinkRouting = matchesSettingsSearch(searchQuery, [BROWSER_PANE_SEARCH_ENTRIES[1]]);
    const showCookies = matchesSettingsSearch(searchQuery, [BROWSER_PANE_SEARCH_ENTRIES[2]]);
    return (_jsxs("div", { className: "space-y-4", children: [showHomePage ? (_jsxs(SearchableSetting, { title: "Default Home Page", description: "URL opened when creating a new browser tab. Leave empty to open a blank tab.", keywords: ['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank'], className: "flex items-start justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "min-w-0 shrink space-y-0.5", children: [_jsx(Label, { children: "Default Home Page" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "URL opened when creating a new browser tab. Leave empty to open a blank tab." })] }), _jsxs("form", { className: "flex shrink-0 items-center gap-2", onSubmit: (e) => {
                            e.preventDefault();
                            const trimmed = homePageDraft.trim();
                            if (!trimmed) {
                                setBrowserDefaultUrl(null);
                                return;
                            }
                            const normalized = normalizeBrowserNavigationUrl(trimmed);
                            if (normalized && normalized !== ORCA_BROWSER_BLANK_URL) {
                                setBrowserDefaultUrl(normalized);
                                setHomePageDraft(normalized);
                                toast.success('Home page saved.');
                            }
                        }, children: [_jsx(Input, { value: homePageDraft, onChange: (e) => setHomePageDraft(e.target.value), placeholder: "https://google.com", spellCheck: false, autoCapitalize: "none", autoCorrect: "off", className: "h-7 w-52 text-xs" }), _jsx(Button, { type: "submit", size: "sm", variant: "outline", className: "h-7 text-xs", children: "Save" })] })] })) : null, showLinkRouting ? (_jsxs(SearchableSetting, { title: "Terminal Link Routing", description: "Cmd/Ctrl+click opens terminal http(s) links in Orca. Shift+Cmd/Ctrl+click uses the system browser.", keywords: ['browser', 'preview', 'links', 'localhost', 'webview'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Terminal Link Routing" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Cmd/Ctrl+click opens terminal links in Orca. Shift+Cmd/Ctrl+click opens the same link in your system browser." })] }), _jsx("button", { role: "switch", "aria-checked": settings.openLinksInApp, onClick: () => updateSettings({ openLinksInApp: !settings.openLinksInApp }), className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.openLinksInApp ? 'bg-foreground' : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${settings.openLinksInApp ? 'translate-x-4' : 'translate-x-0.5'}` }) })] })) : null, showCookies ? (_jsxs(SearchableSetting, { title: "Session & Cookies", description: "Import cookies from Chrome, Edge, or other browsers to use existing logins inside Orca.", keywords: [
                    'cookies',
                    'session',
                    'import',
                    'auth',
                    'login',
                    'chrome',
                    'edge',
                    'arc',
                    'profile'
                ], className: "space-y-3 px-1 py-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Session & Cookies" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Import cookies from your system browser to reuse existing logins inside Orca." })] }), _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { variant: "outline", size: "xs", className: "shrink-0 gap-1.5", disabled: browserSessionImportState?.status === 'importing', children: [browserSessionImportState?.status === 'importing' ? (_jsx(Loader2, { className: "size-3 animate-spin" })) : (_jsx(Import, { className: "size-3" })), "Import Cookies"] }) }), _jsxs(DropdownMenuContent, { align: "end", children: [detectedBrowsers.map((browser) => (_jsxs(DropdownMenuItem, { onSelect: async () => {
                                                    const store = useAppStore.getState();
                                                    const result = await store.importCookiesFromBrowser('default', browser.family);
                                                    if (result.ok) {
                                                        toast.success(`Imported ${result.summary.importedCookies} cookies from ${browser.label}.`);
                                                    }
                                                    else {
                                                        toast.error(result.reason);
                                                    }
                                                }, children: ["From ", browser.label] }, browser.family))), detectedBrowsers.length > 0 && _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuItem, { onSelect: async () => {
                                                    const store = useAppStore.getState();
                                                    const result = await store.importCookiesToProfile('default');
                                                    if (result.ok) {
                                                        toast.success(`Imported ${result.summary.importedCookies} cookies from file.`);
                                                    }
                                                    else if (result.reason !== 'canceled') {
                                                        toast.error(result.reason);
                                                    }
                                                }, children: "From File\u2026" })] })] })] }), defaultProfile?.source ? (_jsxs("div", { className: "flex w-full items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2.5", children: [_jsxs("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5", children: [_jsxs("span", { className: "truncate text-sm font-medium", children: ["Imported from ", defaultProfile.source.browserFamily, defaultProfile.source.profileName
                                                ? ` (${defaultProfile.source.profileName})`
                                                : ''] }), defaultProfile.source.importedAt ? (_jsx("span", { className: "truncate text-[11px] text-muted-foreground", children: new Date(defaultProfile.source.importedAt).toLocaleDateString(undefined, {
                                            month: 'short',
                                            day: 'numeric',
                                            hour: 'numeric',
                                            minute: '2-digit'
                                        }) })) : null] }), _jsxs(Button, { variant: "ghost", size: "xs", className: "gap-1 text-muted-foreground hover:text-destructive", onClick: async () => {
                                    const ok = await useAppStore.getState().clearDefaultSessionCookies();
                                    if (ok) {
                                        toast.success('Cookies cleared.');
                                    }
                                }, children: [_jsx(Trash2, { className: "size-3" }), "Clear"] })] })) : null, orphanedProfiles.length > 0 ? (_jsx("div", { className: "space-y-2", children: orphanedProfiles.map((profile) => (_jsxs("div", { className: "flex w-full items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2.5", children: [_jsxs("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5", children: [_jsx("span", { className: "truncate text-sm font-medium", children: profile.label }), _jsx("span", { className: "truncate text-[11px] text-muted-foreground", children: profile.source
                                                ? `Imported from ${profile.source.browserFamily}${profile.source.profileName ? ` (${profile.source.profileName})` : ''}`
                                                : 'Unused session' })] }), _jsxs(Button, { variant: "ghost", size: "xs", className: "gap-1 text-muted-foreground hover:text-destructive", onClick: async () => {
                                        const ok = await useAppStore
                                            .getState()
                                            .deleteBrowserSessionProfile(profile.id);
                                        if (ok) {
                                            toast.success('Session removed.');
                                        }
                                    }, children: [_jsx(Trash2, { className: "size-3" }), "Remove"] })] }, profile.id))) })) : null] })) : null] }));
}
