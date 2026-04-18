import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Bell, Bot, GitBranch, Globe, Keyboard, Palette, Server, SlidersHorizontal, SquareTerminal } from 'lucide-react';
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind';
import { useAppStore } from '../../store';
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark';
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers';
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants';
import { GeneralPane, GENERAL_PANE_SEARCH_ENTRIES } from './GeneralPane';
import { BrowserPane, BROWSER_PANE_SEARCH_ENTRIES } from './BrowserPane';
import { AppearancePane, APPEARANCE_PANE_SEARCH_ENTRIES } from './AppearancePane';
import { ShortcutsPane, SHORTCUTS_PANE_SEARCH_ENTRIES } from './ShortcutsPane';
import { TerminalPane } from './TerminalPane';
import { RepositoryPane, getRepositoryPaneSearchEntries } from './RepositoryPane';
import { getTerminalPaneSearchEntries } from './terminal-search';
import { GitPane, GIT_PANE_SEARCH_ENTRIES } from './GitPane';
import { NotificationsPane, NOTIFICATIONS_PANE_SEARCH_ENTRIES } from './NotificationsPane';
import { SshPane, SSH_PANE_SEARCH_ENTRIES } from './SshPane';
import { AgentsPane, AGENTS_PANE_SEARCH_ENTRIES } from './AgentsPane';
import { StatsPane, STATS_PANE_SEARCH_ENTRIES } from '../stats/StatsPane';
import { SettingsSidebar } from './SettingsSidebar';
import { SettingsSection } from './SettingsSection';
import { matchesSettingsSearch } from './settings-search';
function getSettingsSectionId(pane, repoId) {
    if (pane === 'repo' && repoId) {
        return `repo-${repoId}`;
    }
    return pane;
}
function getFallbackVisibleSection(sections) {
    return sections.at(0);
}
function Settings() {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const fetchSettings = useAppStore((s) => s.fetchSettings);
    const closeSettingsPage = useAppStore((s) => s.closeSettingsPage);
    const repos = useAppStore((s) => s.repos);
    const updateRepo = useAppStore((s) => s.updateRepo);
    const removeRepo = useAppStore((s) => s.removeRepo);
    const settingsNavigationTarget = useAppStore((s) => s.settingsNavigationTarget);
    const clearSettingsTarget = useAppStore((s) => s.clearSettingsTarget);
    const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery);
    const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery);
    const [repoHooksMap, setRepoHooksMap] = useState({});
    const systemPrefersDark = useSystemPrefersDark();
    const isWindows = isWindowsUserAgent();
    const isMac = isMacUserAgent();
    // Why: the Terminal settings section shares one search index with the
    // sidebar. We trim platform-only entries on other platforms so search never
    // reveals controls that the renderer will intentionally hide.
    const terminalPaneSearchEntries = useMemo(() => getTerminalPaneSearchEntries({ isWindows, isMac }), [isWindows, isMac]);
    const [scrollbackMode, setScrollbackMode] = useState('preset');
    const [prevScrollbackBytes, setPrevScrollbackBytes] = useState(settings?.terminalScrollbackBytes);
    const [terminalFontSuggestions, setTerminalFontSuggestions] = useState(getFallbackTerminalFonts());
    const [activeSectionId, setActiveSectionId] = useState('general');
    const contentScrollRef = useRef(null);
    const terminalFontsLoadedRef = useRef(false);
    const pendingNavSectionRef = useRef(null);
    const pendingScrollTargetRef = useRef(null);
    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);
    useEffect(() => () => {
        // Why: the settings search is a transient in-page filter. Leaving it behind makes the next
        // visit look partially broken because whole sections stay hidden before the user types again.
        setSettingsSearchQuery('');
    }, [setSettingsSearchQuery]);
    useEffect(() => {
        if (!settingsNavigationTarget) {
            return;
        }
        const paneSectionId = getSettingsSectionId(settingsNavigationTarget.pane, settingsNavigationTarget.repoId);
        pendingNavSectionRef.current = paneSectionId;
        pendingScrollTargetRef.current = settingsNavigationTarget.sectionId ?? paneSectionId;
        clearSettingsTarget();
    }, [clearSettingsTarget, settingsNavigationTarget]);
    useEffect(() => {
        if (terminalFontsLoadedRef.current) {
            return;
        }
        let stale = false;
        const loadFontSuggestions = async () => {
            try {
                const fonts = await window.api.settings.listFonts();
                if (stale || fonts.length === 0) {
                    return;
                }
                terminalFontsLoadedRef.current = true;
                setTerminalFontSuggestions((prev) => Array.from(new Set([...fonts, ...prev])).slice(0, 320));
            }
            catch {
                // Fall back to curated cross-platform suggestions.
            }
        };
        void loadFontSuggestions();
        return () => {
            stale = true;
        };
    }, []);
    // Why: only recompute scrollback mode when the byte value actually changes,
    // not on every unrelated settings mutation.
    if (settings?.terminalScrollbackBytes !== prevScrollbackBytes) {
        setPrevScrollbackBytes(settings?.terminalScrollbackBytes);
        if (settings) {
            const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000));
            setScrollbackMode(SCROLLBACK_PRESETS_MB.includes(scrollbackMb)
                ? 'preset'
                : 'custom');
        }
    }
    useEffect(() => {
        let stale = false;
        const checkHooks = async () => {
            const results = await Promise.all(repos.map(async (repo) => {
                if (isFolderRepo(repo)) {
                    return [repo.id, { hasHooks: false, hooks: null, mayNeedUpdate: false }];
                }
                try {
                    const result = await window.api.hooks.check({ repoId: repo.id });
                    return [repo.id, result];
                }
                catch {
                    return [repo.id, { hasHooks: false, hooks: null, mayNeedUpdate: false }];
                }
            }));
            if (!stale) {
                setRepoHooksMap(Object.fromEntries(results));
            }
        };
        if (repos.length > 0) {
            void checkHooks();
        }
        else {
            setRepoHooksMap({});
        }
        return () => {
            stale = true;
        };
    }, [repos]);
    const applyTheme = useCallback((theme) => {
        const root = document.documentElement;
        if (theme === 'dark') {
            root.classList.add('dark');
        }
        else if (theme === 'light') {
            root.classList.remove('dark');
        }
        else {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (prefersDark) {
                root.classList.add('dark');
            }
            else {
                root.classList.remove('dark');
            }
        }
    }, []);
    const displayedGitUsername = repos[0]?.gitUsername ?? '';
    const navSections = useMemo(() => [
        {
            id: 'general',
            title: 'General',
            description: 'Workspace, editor, and updates.',
            icon: SlidersHorizontal,
            searchEntries: GENERAL_PANE_SEARCH_ENTRIES
        },
        {
            id: 'agents',
            title: 'Agents',
            description: 'Manage AI agents, set a default, and customize commands.',
            icon: Bot,
            searchEntries: AGENTS_PANE_SEARCH_ENTRIES
        },
        {
            id: 'git',
            title: 'Git',
            description: 'Branch naming and local ref behavior.',
            icon: GitBranch,
            searchEntries: GIT_PANE_SEARCH_ENTRIES
        },
        {
            id: 'appearance',
            title: 'Appearance',
            description: 'Theme and UI scaling.',
            icon: Palette,
            searchEntries: APPEARANCE_PANE_SEARCH_ENTRIES
        },
        {
            id: 'terminal',
            title: 'Terminal',
            description: 'Terminal appearance, previews, and defaults for new panes.',
            icon: SquareTerminal,
            searchEntries: terminalPaneSearchEntries
        },
        {
            id: 'browser',
            title: 'Browser',
            description: 'Home page, link routing, and session cookies.',
            icon: Globe,
            searchEntries: BROWSER_PANE_SEARCH_ENTRIES
        },
        {
            id: 'notifications',
            title: 'Notifications',
            description: 'Native desktop notifications for agent and terminal events.',
            icon: Bell,
            searchEntries: NOTIFICATIONS_PANE_SEARCH_ENTRIES
        },
        {
            id: 'shortcuts',
            title: 'Shortcuts',
            description: 'Keyboard shortcuts for common actions.',
            icon: Keyboard,
            searchEntries: SHORTCUTS_PANE_SEARCH_ENTRIES
        },
        {
            id: 'stats',
            title: 'Stats & Usage',
            description: 'Orca stats and Claude usage analytics.',
            icon: BarChart3,
            searchEntries: STATS_PANE_SEARCH_ENTRIES
        },
        {
            id: 'ssh',
            title: 'SSH',
            description: 'Remote SSH connections.',
            icon: Server,
            searchEntries: SSH_PANE_SEARCH_ENTRIES,
            badge: 'Beta'
        },
        ...repos.map((repo) => ({
            id: `repo-${repo.id}`,
            title: repo.displayName,
            description: `${getRepoKindLabel(repo)} • ${repo.path}`,
            icon: SlidersHorizontal,
            searchEntries: getRepositoryPaneSearchEntries(repo)
        }))
    ], [repos, terminalPaneSearchEntries]);
    const visibleNavSections = useMemo(() => navSections.filter((section) => matchesSettingsSearch(settingsSearchQuery, section.searchEntries)), [navSections, settingsSearchQuery]);
    useEffect(() => {
        const scrollTargetId = pendingScrollTargetRef.current;
        const pendingNavSectionId = pendingNavSectionRef.current;
        const visibleIds = new Set(visibleNavSections.map((section) => section.id));
        if (scrollTargetId && pendingNavSectionId && visibleIds.has(pendingNavSectionId)) {
            const target = document.getElementById(scrollTargetId);
            target?.scrollIntoView({ block: 'start' });
            setActiveSectionId(pendingNavSectionId);
            pendingNavSectionRef.current = null;
            pendingScrollTargetRef.current = null;
            return;
        }
        if (scrollTargetId && pendingNavSectionId && settingsSearchQuery.trim() !== '') {
            setSettingsSearchQuery('');
            return;
        }
        if (!visibleIds.has(activeSectionId) && visibleNavSections.length > 0) {
            setActiveSectionId(getFallbackVisibleSection(visibleNavSections)?.id ?? activeSectionId);
        }
    }, [activeSectionId, setSettingsSearchQuery, settingsSearchQuery, visibleNavSections]);
    useEffect(() => {
        const container = contentScrollRef.current;
        if (!container) {
            return;
        }
        const updateActiveSection = () => {
            const sections = Array.from(container.querySelectorAll('[data-settings-section]'));
            if (sections.length === 0) {
                return;
            }
            const containerTop = container.getBoundingClientRect().top;
            const candidate = sections.find((section) => section.getBoundingClientRect().top - containerTop >= -24) ??
                sections.at(-1);
            if (!candidate) {
                return;
            }
            setActiveSectionId(candidate.dataset.settingsSection ?? candidate.id);
        };
        let rafId = null;
        const throttledUpdateActiveSection = () => {
            if (rafId !== null) {
                return;
            }
            rafId = requestAnimationFrame(() => {
                rafId = null;
                updateActiveSection();
            });
        };
        updateActiveSection();
        container.addEventListener('scroll', throttledUpdateActiveSection, { passive: true });
        return () => {
            container.removeEventListener('scroll', throttledUpdateActiveSection);
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
        };
    }, [visibleNavSections]);
    const scrollToSection = useCallback((sectionId) => {
        const target = document.getElementById(sectionId);
        if (!target) {
            return;
        }
        target.scrollIntoView({ block: 'start' });
        setActiveSectionId(sectionId);
    }, []);
    if (!settings) {
        return (_jsx("div", { className: "flex flex-1 items-center justify-center text-muted-foreground", children: "Loading settings..." }));
    }
    const generalNavSections = visibleNavSections.filter((section) => !section.id.startsWith('repo-'));
    const repoNavSections = visibleNavSections
        .filter((section) => section.id.startsWith('repo-'))
        .map((section) => {
        const repo = repos.find((entry) => entry.id === section.id.replace('repo-', ''));
        return { ...section, badgeColor: repo?.badgeColor, isRemote: !!repo?.connectionId };
    });
    return (_jsxs("div", { className: "settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background", children: [_jsx(SettingsSidebar, { activeSectionId: activeSectionId, generalSections: generalNavSections, repoSections: repoNavSections, hasRepos: repos.length > 0, searchQuery: settingsSearchQuery, onBack: closeSettingsPage, onSearchChange: setSettingsSearchQuery, onSelectSection: scrollToSection }), _jsx("div", { className: "flex min-h-0 flex-1 flex-col", children: _jsx("div", { ref: contentScrollRef, className: "min-h-0 flex-1 overflow-y-auto scrollbar-sleek", children: _jsx("div", { className: "flex w-full max-w-5xl flex-col gap-10 px-8 py-10", children: visibleNavSections.length === 0 ? (_jsxs("div", { className: "flex min-h-[24rem] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground", children: ["No settings found for \"", settingsSearchQuery.trim(), "\""] })) : (_jsxs(_Fragment, { children: [_jsx(SettingsSection, { id: "general", title: "General", description: "Workspace, editor, and updates.", searchEntries: GENERAL_PANE_SEARCH_ENTRIES, children: _jsx(GeneralPane, { settings: settings, updateSettings: updateSettings }) }), _jsx(SettingsSection, { id: "agents", title: "Agents", description: "Manage AI agents, set a default, and customize commands.", searchEntries: AGENTS_PANE_SEARCH_ENTRIES, children: _jsx(AgentsPane, { settings: settings, updateSettings: updateSettings }) }), _jsx(SettingsSection, { id: "git", title: "Git", description: "Branch naming and local ref behavior.", searchEntries: GIT_PANE_SEARCH_ENTRIES, children: _jsx(GitPane, { settings: settings, updateSettings: updateSettings, displayedGitUsername: displayedGitUsername }) }), _jsx(SettingsSection, { id: "appearance", title: "Appearance", description: "Theme and UI scaling.", searchEntries: APPEARANCE_PANE_SEARCH_ENTRIES, children: _jsx(AppearancePane, { settings: settings, updateSettings: updateSettings, applyTheme: applyTheme }) }), _jsx(SettingsSection, { id: "terminal", title: "Terminal", description: "Terminal appearance, previews, and defaults for new panes.", searchEntries: terminalPaneSearchEntries, children: _jsx(TerminalPane, { settings: settings, updateSettings: updateSettings, systemPrefersDark: systemPrefersDark, terminalFontSuggestions: terminalFontSuggestions, scrollbackMode: scrollbackMode, setScrollbackMode: setScrollbackMode }) }), _jsx(SettingsSection, { id: "browser", title: "Browser", description: "Home page, link routing, and session cookies.", searchEntries: BROWSER_PANE_SEARCH_ENTRIES, children: _jsx(BrowserPane, { settings: settings, updateSettings: updateSettings }) }), _jsx(SettingsSection, { id: "notifications", title: "Notifications", description: "Native desktop notifications for agent activity and terminal events.", searchEntries: NOTIFICATIONS_PANE_SEARCH_ENTRIES, children: _jsx(NotificationsPane, { settings: settings, updateSettings: updateSettings }) }), _jsx(SettingsSection, { id: "shortcuts", title: "Shortcuts", description: "Keyboard shortcuts for common actions.", searchEntries: SHORTCUTS_PANE_SEARCH_ENTRIES, children: _jsx(ShortcutsPane, {}) }), _jsx(SettingsSection, { id: "stats", title: "Stats", description: "How much Orca has helped you.", searchEntries: STATS_PANE_SEARCH_ENTRIES, children: _jsx(StatsPane, {}) }), _jsx(SettingsSection, { id: "ssh", title: "SSH", badge: "Beta", description: "Manage remote SSH connections. Connect to remote servers to browse files, run terminals, and use git.", searchEntries: SSH_PANE_SEARCH_ENTRIES, children: _jsx(SshPane, {}) }), repos.map((repo) => {
                                    const repoSectionId = `repo-${repo.id}`;
                                    const repoHooksState = repoHooksMap[repo.id];
                                    return (_jsx(SettingsSection, { id: repoSectionId, title: repo.displayName, description: repo.path, searchEntries: getRepositoryPaneSearchEntries(repo), children: _jsx(RepositoryPane, { repo: repo, yamlHooks: repoHooksState?.hooks ?? null, hasHooksFile: repoHooksState?.hasHooks ?? false, mayNeedUpdate: repoHooksState?.mayNeedUpdate ?? false, updateRepo: updateRepo, removeRepo: removeRepo }) }, repo.id));
                                })] })) }) }) })] }));
}
export default Settings;
