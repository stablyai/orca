import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { UIZoomControl } from './UIZoomControl';
import { SearchableSetting } from './SearchableSetting';
import { matchesSettingsSearch } from './settings-search';
import { useAppStore } from '../../store';
export const APPEARANCE_PANE_SEARCH_ENTRIES = [
    {
        title: 'Theme',
        description: 'Choose how Orca looks in the app window.',
        keywords: ['dark', 'light', 'system']
    },
    {
        title: 'UI Zoom',
        description: 'Scale the entire application interface.',
        keywords: ['zoom', 'scale', 'shortcut']
    },
    {
        title: 'Open Right Sidebar by Default',
        description: 'Automatically expand the file explorer panel when creating a new worktree.',
        keywords: ['layout', 'file explorer', 'sidebar']
    },
    {
        title: 'Titlebar Agent Activity',
        description: 'Show the number of active agents in the titlebar.',
        keywords: ['titlebar', 'agent', 'badge', 'active', 'count', 'status']
    }
];
export function AppearancePane({ settings, updateSettings, applyTheme }) {
    const searchQuery = useAppStore((state) => state.settingsSearchQuery);
    const isMac = navigator.userAgent.includes('Mac');
    const zoomInLabel = isMac ? '⌘+' : 'Ctrl +';
    const zoomOutLabel = isMac ? '⌘-' : 'Ctrl -';
    const themeEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(0, 1);
    const zoomEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(1, 2);
    const layoutEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(2, 3);
    const titlebarEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(3);
    const visibleSections = [
        matchesSettingsSearch(searchQuery, themeEntries) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Theme" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Choose how Orca looks in the app window." })] }), _jsx(SearchableSetting, { title: "Theme", description: "Choose how Orca looks in the app window.", keywords: ['dark', 'light', 'system'], children: _jsx("div", { className: "flex w-fit gap-1 rounded-md border border-border/50 p-1", children: ['system', 'dark', 'light'].map((option) => (_jsx("button", { onClick: () => {
                                updateSettings({ theme: option });
                                applyTheme(option);
                            }, className: `rounded-sm px-3 py-1 text-sm capitalize transition-colors ${settings.theme === option
                                ? 'bg-accent font-medium text-accent-foreground'
                                : 'text-muted-foreground hover:text-foreground'}`, children: option }, option))) }) })] }, "theme")) : null,
        matchesSettingsSearch(searchQuery, zoomEntries) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "UI Zoom" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Scale the entire application interface. Use", ' ', _jsx("kbd", { className: "rounded border px-1 py-0.5 text-[10px]", children: zoomInLabel }), " /", ' ', _jsx("kbd", { className: "rounded border px-1 py-0.5 text-[10px]", children: zoomOutLabel }), " when not in a terminal pane."] })] }), _jsx(SearchableSetting, { title: "UI Zoom", description: "Scale the entire application interface.", keywords: ['zoom', 'scale', 'shortcut'], children: _jsx(UIZoomControl, {}) })] }, "zoom")) : null,
        matchesSettingsSearch(searchQuery, layoutEntries) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Layout" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Default layout when creating new worktrees." })] }), _jsxs(SearchableSetting, { title: "Open Right Sidebar by Default", description: "Automatically expand the file explorer panel when creating a new worktree.", keywords: ['layout', 'file explorer', 'sidebar'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Open Right Sidebar by Default" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Automatically expand the file explorer panel when creating a new worktree." })] }), _jsx("button", { role: "switch", "aria-checked": settings.rightSidebarOpenByDefault, onClick: () => updateSettings({
                                rightSidebarOpenByDefault: !settings.rightSidebarOpenByDefault
                            }), className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.rightSidebarOpenByDefault ? 'bg-foreground' : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${settings.rightSidebarOpenByDefault ? 'translate-x-4' : 'translate-x-0.5'}` }) })] })] }, "layout")) : null,
        matchesSettingsSearch(searchQuery, titlebarEntries) ? (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-sm font-semibold", children: "Titlebar" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Control what appears in the application titlebar." })] }), _jsxs(SearchableSetting, { title: "Titlebar Agent Activity", description: "Show the number of active agents in the titlebar.", keywords: ['titlebar', 'agent', 'badge', 'active', 'count', 'status'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Titlebar Agent Activity" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Show the number of active agents in the titlebar." })] }), _jsx("button", { role: "switch", "aria-checked": settings.showTitlebarAgentActivity, onClick: () => updateSettings({
                                showTitlebarAgentActivity: !settings.showTitlebarAgentActivity
                            }), className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.showTitlebarAgentActivity ? 'bg-foreground' : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${settings.showTitlebarAgentActivity ? 'translate-x-4' : 'translate-x-0.5'}` }) })] })] }, "titlebar")) : null
    ].filter(Boolean);
    return (_jsx("div", { className: "space-y-8", children: visibleSections.map((section, index) => (_jsxs("div", { className: "space-y-8", children: [index > 0 ? _jsx(Separator, {}) : null, section] }, index))) }));
}
