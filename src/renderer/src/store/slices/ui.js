// Why: mirrors the preset→query mapping used by NewWorkspacePage's preset
// buttons. Keeping a local copy here avoids a store ↔ lib circular import
// while letting openNewWorkspacePage warm exactly the cache key the page will
// read on mount.
function presetToQuery(presetId) {
    switch (presetId) {
        case 'my-issues':
            return 'assignee:@me is:open';
        case 'review':
            return 'review-requested:@me is:open';
        case 'my-prs':
            return 'author:@me is:open';
        default:
            return 'is:open';
    }
}
import { DEFAULT_STATUS_BAR_ITEMS, DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../shared/constants';
const MIN_SIDEBAR_WIDTH = 220;
const MAX_LEFT_SIDEBAR_WIDTH = 500;
// Why: the right sidebar drag-resize is window-relative (see right-sidebar
// component), so persisted widths can legitimately be well above the old 500px
// cap on wide displays. Use a large hard ceiling purely as a safety net for
// corrupted/manually-edited values rather than as a product limit.
const MAX_RIGHT_SIDEBAR_WIDTH = 4000;
function sanitizePersistedSidebarWidth(width, fallback, maxWidth) {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
        return fallback;
    }
    return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width));
}
export const createUISlice = (set, get) => ({
    sidebarOpen: true,
    sidebarWidth: 280,
    toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    setSidebarOpen: (open) => set({ sidebarOpen: open }),
    setSidebarWidth: (width) => set({ sidebarWidth: width }),
    activeView: 'terminal',
    previousViewBeforeNewWorkspace: 'terminal',
    previousViewBeforeSettings: 'terminal',
    setActiveView: (view) => set({ activeView: view }),
    newWorkspacePageData: {},
    newWorkspaceDraft: null,
    openNewWorkspacePage: (data = {}) => {
        set((state) => ({
            activeView: 'new-workspace',
            previousViewBeforeNewWorkspace: state.activeView === 'new-workspace'
                ? state.previousViewBeforeNewWorkspace
                : state.activeView,
            newWorkspacePageData: data
        }));
        // Why: prefetch the GitHub work-item list in parallel with React's first
        // render of the NewWorkspacePage — by the time the page's own effect runs,
        // the SWR cache is either already populated or the request is in-flight
        // and will be deduped. This removes ~300–800ms of perceived latency on
        // initial page load.
        const state = get();
        const targetRepoId = data.preselectedRepoId ?? state.activeRepoId ?? state.repos.find((r) => r.path)?.id ?? null;
        const repo = targetRepoId ? state.repos.find((r) => r.id === targetRepoId) : null;
        if (repo?.path) {
            const preset = state.settings?.defaultTaskViewPreset ?? 'all';
            state.prefetchWorkItems(repo.path, 36, presetToQuery(preset));
        }
    },
    closeNewWorkspacePage: () => set((state) => ({
        activeView: state.previousViewBeforeNewWorkspace,
        newWorkspacePageData: {}
    })),
    setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
    clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null }),
    openSettingsPage: () => set((state) => ({
        activeView: 'settings',
        // Why: Settings is a temporary detour from either terminal or the
        // full-page new-workspace composer. Preserve the originating view so the
        // Settings back action restores an in-progress workspace draft instead of
        // always dumping the user into terminal.
        previousViewBeforeSettings: state.activeView === 'settings' ? state.previousViewBeforeSettings : state.activeView
    })),
    closeSettingsPage: () => set((state) => ({
        activeView: state.previousViewBeforeSettings
    })),
    settingsNavigationTarget: null,
    openSettingsTarget: (target) => set({ settingsNavigationTarget: target }),
    clearSettingsTarget: () => set({ settingsNavigationTarget: null }),
    activeModal: 'none',
    modalData: {},
    openModal: (modal, data = {}) => set({ activeModal: modal, modalData: data }),
    closeModal: () => set({ activeModal: 'none', modalData: {} }),
    searchQuery: '',
    setSearchQuery: (q) => set({ searchQuery: q }),
    groupBy: 'none',
    setGroupBy: (g) => set({ groupBy: g }),
    sortBy: 'name',
    setSortBy: (s) => set({ sortBy: s }),
    showActiveOnly: false,
    setShowActiveOnly: (v) => set({ showActiveOnly: v }),
    filterRepoIds: [],
    setFilterRepoIds: (ids) => set({ filterRepoIds: ids }),
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    toggleWorktreeCardProperty: (prop) => set((s) => {
        const current = s.worktreeCardProperties || DEFAULT_WORKTREE_CARD_PROPERTIES;
        const updated = current.includes(prop)
            ? current.filter((p) => p !== prop)
            : [...current, prop];
        window.api.ui.set({ worktreeCardProperties: updated }).catch(console.error);
        return { worktreeCardProperties: updated };
    }),
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    toggleStatusBarItem: (item) => set((s) => {
        const current = s.statusBarItems || DEFAULT_STATUS_BAR_ITEMS;
        const updated = current.includes(item)
            ? current.filter((i) => i !== item)
            : [...current, item];
        window.api.ui.set({ statusBarItems: updated }).catch(console.error);
        return { statusBarItems: updated };
    }),
    statusBarVisible: true,
    setStatusBarVisible: (v) => {
        window.api.ui.set({ statusBarVisible: v }).catch(console.error);
        set({ statusBarVisible: v });
    },
    pendingRevealWorktreeId: null,
    revealWorktreeInSidebar: (worktreeId) => set({ pendingRevealWorktreeId: worktreeId }),
    clearPendingRevealWorktreeId: () => set({ pendingRevealWorktreeId: null }),
    persistedUIReady: false,
    uiZoomLevel: 0,
    setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
    editorFontZoomLevel: 0,
    setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level }),
    hydratePersistedUI: (ui) => set((s) => {
        const validRepoIds = new Set(s.repos.map((repo) => repo.id));
        // Migration history:
        // v1: sort was called 'smart' internally
        // v2: renamed 'smart' → 'recent' (same weighted-score behavior)
        // v3: 'smart' reintroduced as the weighted-score sort, 'recent' becomes
        //     a creation-time sort. The one-shot migration from old 'recent'
        //     to 'smart' now happens in the main process (persistence.ts load())
        //     using the _sortBySmartMigrated flag — not here — so that users who
        //     intentionally select the new 'recent' sort keep it across restarts.
        const sortBy = ui.sortBy;
        return {
            // Why: persisted UI data comes from disk and may be stale, corrupted,
            // or manually edited. Clamp widths during hydration so invalid values
            // cannot push the renderer into broken layouts before the user drags a
            // sidebar again.
            sidebarWidth: sanitizePersistedSidebarWidth(ui.sidebarWidth, s.sidebarWidth, MAX_LEFT_SIDEBAR_WIDTH),
            rightSidebarWidth: sanitizePersistedSidebarWidth(ui.rightSidebarWidth, s.rightSidebarWidth, MAX_RIGHT_SIDEBAR_WIDTH),
            groupBy: ui.groupBy,
            sortBy,
            // Why: "Active only" is part of the user's sidebar working set, not a
            // transient render detail. Restoring it on launch keeps the filtered
            // worktree list stable across restarts instead of silently widening it.
            showActiveOnly: ui.showActiveOnly,
            filterRepoIds: (ui.filterRepoIds ?? []).filter((repoId) => validRepoIds.has(repoId)),
            uiZoomLevel: ui.uiZoomLevel ?? 0,
            editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
            worktreeCardProperties: ui.worktreeCardProperties ?? [...DEFAULT_WORKTREE_CARD_PROPERTIES],
            statusBarItems: ui.statusBarItems ?? [...DEFAULT_STATUS_BAR_ITEMS],
            statusBarVisible: ui.statusBarVisible ?? true,
            dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
            updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
            browserDefaultUrl: ui.browserDefaultUrl ?? null,
            persistedUIReady: true
        };
    }),
    updateStatus: { state: 'idle' },
    setUpdateStatus: (status) => {
        const update = {
            updateStatus: status
        };
        if (status.state === 'available') {
            // Why: cache changelog from each 'available' payload so the card retains
            // rich content across downloading/error/downloaded transitions. Always
            // overwrite (even with null) to prevent a previous rich changelog from
            // leaking into a later simple-mode update for a different version.
            update.updateChangelog = status.changelog ?? null;
        }
        else if (status.state === 'idle' ||
            status.state === 'checking' ||
            status.state === 'not-available') {
            // Why: reset on cycle-boundary states so stale rich content from a
            // previous update cycle cannot resurface.
            update.updateChangelog = null;
        }
        // For 'downloading', 'downloaded', 'error': leave updateChangelog untouched
        // so the card can keep showing rich content from the original 'available'.
        set(update);
    },
    updateChangelog: null,
    dismissedUpdateVersion: null,
    clearDismissedUpdateVersion: () => {
        set({ dismissedUpdateVersion: null });
    },
    dismissUpdate: (versionOverride) => set((s) => {
        // Why: the 'error' variant has no version field, so the card passes
        // the cached version explicitly via versionOverride.
        const dismissedUpdateVersion = versionOverride ?? ('version' in s.updateStatus ? (s.updateStatus.version ?? null) : null);
        const activeNudgeId = 'activeNudgeId' in s.updateStatus ? (s.updateStatus.activeNudgeId ?? null) : null;
        // Why: dismissing an update is user intent, not transient view state. Persist
        // the dismissed version so relaunching the app does not immediately re-show
        // the same reminder card until a newer release appears.
        void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error);
        // Why: only dismiss the main-process nudge campaign when the visible card
        // actually came from a nudge-driven update cycle. Ordinary update dismissals
        // must not consume the active campaign state.
        if (activeNudgeId) {
            void window.api.updater.dismissNudge().catch(console.error);
        }
        return { dismissedUpdateVersion };
    }),
    updateReassuranceSeen: false,
    markUpdateReassuranceSeen: () => {
        void window.api.ui.set({ updateReassuranceSeen: true }).catch(console.error);
        set({ updateReassuranceSeen: true });
    },
    isFullScreen: false,
    setIsFullScreen: (v) => set({ isFullScreen: v }),
    browserDefaultUrl: null,
    setBrowserDefaultUrl: (url) => {
        void window.api.ui.set({ browserDefaultUrl: url }).catch(console.error);
        set({ browserDefaultUrl: url });
    }
});
