/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { findPrevLiveWorktreeHistoryIndex } from './worktree-nav-history'
import type {
  ChangelogData,
  PersistedTrustedOrcaHooks,
  PersistedUIState,
  StatusBarItem,
  TaskViewPresetId,
  TuiAgent,
  UpdateStatus,
  WorktreeCardProperty
} from '../../../../shared/types'
import { PER_REPO_FETCH_LIMIT } from '../../../../shared/work-items'

// Why: mirrors the preset→query mapping used by TaskPage's preset buttons.
// Keeping a local copy here avoids a store ↔ lib circular import while letting
// openTaskPage warm exactly the cache key the page will read on mount.
function presetToQuery(presetId: TaskViewPresetId | null): string {
  switch (presetId) {
    case 'issues':
      return 'is:issue is:open'
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    default:
      return 'is:open'
  }
}
import {
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES
} from '../../../../shared/constants'
import type { OrcaHookScriptKind } from '../../lib/orca-hook-trust'

const MIN_SIDEBAR_WIDTH = 220
const MAX_LEFT_SIDEBAR_WIDTH = 500
// Why: the right sidebar drag-resize is window-relative (see right-sidebar
// component), so persisted widths can legitimately be well above the old 500px
// cap on wide displays. Use a large hard ceiling purely as a safety net for
// corrupted/manually-edited values rather than as a product limit.
const MAX_RIGHT_SIDEBAR_WIDTH = 4000

function filterTrustedOrcaHooksToValidRepos(
  trust: PersistedTrustedOrcaHooks,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (validRepoIds.has(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}

function sanitizePersistedSidebarWidth(width: unknown, fallback: number, maxWidth: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width))
}

export type UISlice = {
  sidebarOpen: boolean
  sidebarWidth: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  /** Per-agent "I've looked at this" timestamps, keyed by paneKey. Set when
   *  the user clicks an agent row or its parent workspace card from the
   *  dashboard. A row is considered unvisited when no ack exists OR the
   *  agent's current stateStartedAt is newer than the last ack (i.e. the
   *  agent has transitioned state since the user last saw it). Session-only
   *  — restart resets everyone to unvisited, which is harmless since the
   *  first visit after launch is a legitimate "need to see" moment. */
  acknowledgedAgentsByPaneKey: Record<string, number>
  acknowledgeAgents: (paneKeys: string[]) => void
  activeView: 'terminal' | 'settings' | 'tasks'
  previousViewBeforeTasks: 'terminal' | 'settings'
  previousViewBeforeSettings: 'terminal' | 'tasks'
  setActiveView: (view: UISlice['activeView']) => void
  taskPageData: {
    preselectedRepoId?: string
    prefilledName?: string
    taskSource?: 'github' | 'linear'
  }
  newWorkspaceDraft: {
    repoId: string | null
    name: string
    prompt: string
    note: string
    attachments: string[]
    linkedWorkItem: {
      type: 'issue' | 'pr'
      number: number
      title: string
      url: string
    } | null
    agent: TuiAgent
    linkedIssue: string
    linkedPR: number | null
    // Why: repo-scoped start ref selected via the "Start from" picker.
    // Absent means "use the repo's effective base ref".
    baseBranch?: string
  } | null
  openTaskPage: (data?: UISlice['taskPageData']) => void
  closeTaskPage: () => void
  setNewWorkspaceDraft: (draft: NonNullable<UISlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  openSettingsPage: () => void
  closeSettingsPage: () => void
  settingsNavigationTarget: {
    pane:
      | 'general'
      | 'browser'
      | 'appearance'
      | 'terminal'
      | 'developer-permissions'
      | 'shortcuts'
      | 'repo'
      | 'agents'
      | 'accounts'
      | 'experimental'
      | 'ssh'
    repoId: string | null
    sectionId?: string
  } | null
  openSettingsTarget: (target: NonNullable<UISlice['settingsNavigationTarget']>) => void
  clearSettingsTarget: () => void
  activeModal:
    | 'none'
    | 'create-worktree'
    | 'edit-meta'
    | 'delete-worktree'
    | 'confirm-non-git-folder'
    | 'confirm-remove-folder'
    | 'add-repo'
    | 'quick-open'
    | 'worktree-palette'
    | 'new-workspace-composer'
    | 'confirm-orca-yaml-hooks'
  modalData: Record<string, unknown>
  openModal: (modal: UISlice['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
  /** Active tab inside the new-workspace composer modal. Mutable while the
   *  modal is open so Cmd+N / Cmd+Shift+N can toggle tabs without tearing
   *  down the composer state. */
  newWorkspaceComposerTab: 'quick' | 'create-from'
  setNewWorkspaceComposerTab: (tab: 'quick' | 'create-from') => void
  /** Remembered sub-tab inside the Create-from tab (PRs / Issues / Branches /
   *  Linear). Persists across composer opens within a session so users who
   *  always start from Linear (for example) don't have to click back to that
   *  tab every time. */
  createFromSubTab: 'prs' | 'issues' | 'branches' | 'linear'
  setCreateFromSubTab: (tab: 'prs' | 'issues' | 'branches' | 'linear') => void
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  markOrcaHookScriptConfirmed: (
    repoId: string,
    kind: OrcaHookScriptKind,
    contentHash: string
  ) => void
  clearOrcaHookTrustForRepo: (repoId: string) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  groupBy: 'none' | 'repo' | 'pr-status'
  setGroupBy: (g: UISlice['groupBy']) => void
  sortBy: 'name' | 'smart' | 'recent' | 'repo'
  setSortBy: (s: UISlice['sortBy']) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  filterRepoIds: string[]
  setFilterRepoIds: (ids: string[]) => void
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
  worktreeCardProperties: WorktreeCardProperty[]
  toggleWorktreeCardProperty: (prop: WorktreeCardProperty) => void
  statusBarItems: StatusBarItem[]
  toggleStatusBarItem: (item: StatusBarItem) => void
  statusBarVisible: boolean
  setStatusBarVisible: (v: boolean) => void
  pendingRevealWorktreeId: string | null
  revealWorktreeInSidebar: (worktreeId: string) => void
  clearPendingRevealWorktreeId: () => void
  persistedUIReady: boolean
  uiZoomLevel: number
  setUIZoomLevel: (level: number) => void
  editorFontZoomLevel: number
  setEditorFontZoomLevel: (level: number) => void
  hydratePersistedUI: (ui: PersistedUIState) => void
  updateStatus: UpdateStatus
  setUpdateStatus: (status: UpdateStatus) => void
  // Why: cached changelog from the last 'available' status so the card still has
  // rich content (title/media/description) during downloading, error, and downloaded
  // states. Cleared on idle/checking/not-available to prevent stale leakage.
  updateChangelog: ChangelogData | null
  dismissedUpdateVersion: string | null
  dismissUpdate: (versionOverride?: string) => void
  clearDismissedUpdateVersion: () => void
  // Why: ephemeral and renderer-only — never persisted and never crosses IPC.
  // Resets every session and on every phase transition (see setUpdateStatus).
  updateCardCollapsed: boolean
  setUpdateCardCollapsed: (collapsed: boolean) => void
  updateReassuranceSeen: boolean
  markUpdateReassuranceSeen: () => void
  isFullScreen: boolean
  setIsFullScreen: (v: boolean) => void
  /** URL opened when a new browser tab is created. Null = blank tab (default). */
  browserDefaultUrl: string | null
  setBrowserDefaultUrl: (url: string | null) => void
  browserDefaultSearchEngine: 'google' | 'duckduckgo' | 'bing' | null
  setBrowserDefaultSearchEngine: (engine: 'google' | 'duckduckgo' | 'bing' | null) => void
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) => ({
  sidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  acknowledgedAgentsByPaneKey: {},
  acknowledgeAgents: (paneKeys) =>
    set((s) => {
      if (paneKeys.length === 0) {
        return s
      }
      const now = Date.now()
      // Why: only allocate a new map (and emit a store update) if at least
      // one ack is actually moving forward. Comparing `prev < now` instead
      // of `prev !== now` matters because stored values are historical
      // timestamps and `Date.now()` advances every millisecond — a strict-
      // inequality guard would fire on every call and rewrite the map on
      // every dashboard click or auto-ack tick, forcing every subscriber
      // (all agent rows, the SidebarHeader count, etc.) to re-render.
      let next: Record<string, number> | null = null
      for (const key of paneKeys) {
        const prev = s.acknowledgedAgentsByPaneKey[key] ?? 0
        if (prev < now) {
          if (next === null) {
            next = { ...s.acknowledgedAgentsByPaneKey }
          }
          next[key] = now
        }
      }
      return next ? { acknowledgedAgentsByPaneKey: next } : s
    }),

  activeView: 'terminal',
  previousViewBeforeTasks: 'terminal',
  previousViewBeforeSettings: 'terminal',
  setActiveView: (view) => set({ activeView: view }),
  taskPageData: {},
  newWorkspaceDraft: null,
  openTaskPage: (data = {}) => {
    // Why: record a Tasks visit in the shared back/forward history so the
    // titlebar Back/Forward buttons can return to Tasks. All task-source
    // variants (github/linear presets) collapse to a single 'tasks' entry;
    // the slice's adjacent-entry dedupe drops re-opens. No isNavigatingHistory
    // guard needed — back-to-Tasks routes through setActiveView('tasks') and
    // never re-enters openTaskPage.
    get().recordViewVisit('tasks')
    set((state) => ({
      activeView: 'tasks',
      previousViewBeforeTasks:
        state.activeView === 'tasks' ? state.previousViewBeforeTasks : state.activeView,
      taskPageData: data
    }))
    // Why: prefetch the GitHub work-item list in parallel with React's first
    // render of the TaskPage — by the time the page's own effect runs, the SWR
    // cache is either already populated or the request is in-flight and will
    // be deduped. This removes ~300–800ms of perceived latency on initial
    // page load.
    const state = get()
    const targetRepoId =
      data.preselectedRepoId ?? state.activeRepoId ?? state.repos.find((r) => r.path)?.id ?? null
    const repo = targetRepoId ? state.repos.find((r) => r.id === targetRepoId) : null
    if (repo?.path) {
      const preset = state.settings?.defaultTaskViewPreset ?? 'all'
      state.prefetchWorkItems(repo.id, repo.path, PER_REPO_FETCH_LIMIT, presetToQuery(preset))
    }
  },
  closeTaskPage: () =>
    set((state) => {
      // Why: Esc-close from Tasks must rewind the history index if we're
      // currently parked on a 'tasks' entry. Without this, A → Tasks → Esc
      // leaves the index at the 'tasks' entry, making Back a visual no-op
      // (activator re-activates A) and Forward re-opens Tasks. If there is no
      // earlier live entry (e.g. history is just ['tasks']), leave the index
      // at 0 — setting it to -1 would lose the only forward target, while the
      // resulting Back visual no-op self-heals as soon as a real visit records
      // a new entry. closeTaskPage never runs from the history-nav path, so no
      // isNavigatingHistory guard is needed.
      const currentEntry = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
      let nextHistoryIndex = state.worktreeNavHistoryIndex
      if (currentEntry === 'tasks') {
        const prev = findPrevLiveWorktreeHistoryIndex(state)
        if (prev !== null) {
          nextHistoryIndex = prev
        }
      }
      return {
        activeView: state.previousViewBeforeTasks,
        taskPageData: {},
        worktreeNavHistoryIndex: nextHistoryIndex
      }
    }),
  setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
  clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null }),
  openSettingsPage: () =>
    set((state) => ({
      activeView: 'settings',
      // Why: Settings is a temporary detour from either terminal or the
      // full-page tasks view. Preserve the originating view so the Settings
      // back action restores an in-progress workspace draft instead of always
      // dumping the user into terminal.
      previousViewBeforeSettings:
        state.activeView === 'settings' ? state.previousViewBeforeSettings : state.activeView
    })),
  closeSettingsPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeSettings
    })),
  settingsNavigationTarget: null,
  openSettingsTarget: (target) => set({ settingsNavigationTarget: target }),
  clearSettingsTarget: () => set({ settingsNavigationTarget: null }),

  activeModal: 'none',
  modalData: {},
  openModal: (modal, data = {}) => {
    // Why: when the new-workspace composer opens, seed its active tab from
    // modalData.initialTab so Cmd+Shift+N lands directly on the "Create from…"
    // tab without the Quick tab flashing first. Default to 'quick' when no
    // explicit target is provided so existing callers keep their behavior.
    if (modal === 'new-workspace-composer') {
      const requestedTab = (data as { initialTab?: 'quick' | 'create-from' }).initialTab
      set({
        activeModal: modal,
        modalData: data,
        newWorkspaceComposerTab: requestedTab ?? 'quick'
      })
      return
    }
    set({ activeModal: modal, modalData: data })
  },
  closeModal: () => set({ activeModal: 'none', modalData: {} }),
  newWorkspaceComposerTab: 'quick',
  setNewWorkspaceComposerTab: (tab) => set({ newWorkspaceComposerTab: tab }),
  createFromSubTab: 'prs',
  setCreateFromSubTab: (tab) => set({ createFromSubTab: tab }),

  trustedOrcaHooks: {},
  markOrcaHookScriptConfirmed: (repoId, kind, contentHash) =>
    set((s) => {
      const existing = s.trustedOrcaHooks[repoId]
      const currentEntry = existing?.[kind]
      if (currentEntry?.contentHash === contentHash) {
        return s
      }
      const nextRepo = {
        ...existing,
        [kind]: { contentHash, approvedAt: Date.now() }
      }
      const next = { ...s.trustedOrcaHooks, [repoId]: nextRepo }
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  clearOrcaHookTrustForRepo: (repoId) =>
    set((s) => {
      if (!(repoId in s.trustedOrcaHooks)) {
        return s
      }
      const next = { ...s.trustedOrcaHooks }
      delete next[repoId]
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),

  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  groupBy: 'none',
  // Why: group keys are mode-specific (e.g. repo id vs PR status), so
  // collapsed state from one mode is meaningless in another. Clearing
  // also prevents unbounded accumulation of stale keys across mode switches.
  setGroupBy: (g) => {
    window.api.ui.set({ collapsedGroups: [] }).catch(console.error)
    set({ groupBy: g, collapsedGroups: new Set<string>() })
  },

  sortBy: 'name',
  setSortBy: (s) => set({ sortBy: s }),

  showActiveOnly: false,
  setShowActiveOnly: (v) => set({ showActiveOnly: v }),

  filterRepoIds: [],
  setFilterRepoIds: (ids) => set({ filterRepoIds: ids }),

  collapsedGroups: new Set<string>(),
  toggleCollapsedGroup: (key) =>
    set((s) => {
      const next = new Set(s.collapsedGroups)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      window.api.ui.set({ collapsedGroups: [...next] }).catch(console.error)
      return { collapsedGroups: next }
    }),

  worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
  toggleWorktreeCardProperty: (prop) =>
    set((s) => {
      const current = s.worktreeCardProperties || DEFAULT_WORKTREE_CARD_PROPERTIES
      const updated = current.includes(prop)
        ? current.filter((p) => p !== prop)
        : [...current, prop]
      window.api.ui.set({ worktreeCardProperties: updated }).catch(console.error)
      return { worktreeCardProperties: updated }
    }),

  statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
  toggleStatusBarItem: (item) =>
    set((s) => {
      const current = s.statusBarItems || DEFAULT_STATUS_BAR_ITEMS
      const updated = current.includes(item)
        ? current.filter((i) => i !== item)
        : [...current, item]
      window.api.ui.set({ statusBarItems: updated }).catch(console.error)
      return { statusBarItems: updated }
    }),

  statusBarVisible: true,
  setStatusBarVisible: (v) => {
    window.api.ui.set({ statusBarVisible: v }).catch(console.error)
    set({ statusBarVisible: v })
  },

  pendingRevealWorktreeId: null,
  revealWorktreeInSidebar: (worktreeId) => set({ pendingRevealWorktreeId: worktreeId }),
  clearPendingRevealWorktreeId: () => set({ pendingRevealWorktreeId: null }),
  persistedUIReady: false,
  uiZoomLevel: 0,
  setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
  editorFontZoomLevel: 0,
  setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level }),

  hydratePersistedUI: (ui) =>
    set((s) => {
      const validRepoIds = new Set(s.repos.map((repo) => repo.id))
      // Migration history:
      // v1: sort was called 'smart' internally
      // v2: renamed 'smart' → 'recent' (same weighted-score behavior)
      // v3: 'smart' reintroduced as the weighted-score sort, 'recent' becomes
      //     a last-activity sort (worktree.lastActivityAt descending). The
      //     one-shot migration from old 'recent' to 'smart' happens in the
      //     main process (persistence.ts load()) using the _sortBySmartMigrated
      //     flag — not here — so that users who intentionally select the new
      //     'recent' sort keep it across restarts.
      const sortBy = ui.sortBy
      return {
        // Why: persisted UI data comes from disk and may be stale, corrupted,
        // or manually edited. Clamp widths during hydration so invalid values
        // cannot push the renderer into broken layouts before the user drags a
        // sidebar again.
        sidebarWidth: sanitizePersistedSidebarWidth(
          ui.sidebarWidth,
          s.sidebarWidth,
          MAX_LEFT_SIDEBAR_WIDTH
        ),
        rightSidebarWidth: sanitizePersistedSidebarWidth(
          ui.rightSidebarWidth,
          s.rightSidebarWidth,
          MAX_RIGHT_SIDEBAR_WIDTH
        ),
        groupBy: ui.groupBy,
        sortBy,
        // Why: "Active only" is part of the user's sidebar working set, not a
        // transient render detail. Restoring it on launch keeps the filtered
        // worktree list stable across restarts instead of silently widening it.
        showActiveOnly: ui.showActiveOnly,
        filterRepoIds: (ui.filterRepoIds ?? []).filter((repoId) => validRepoIds.has(repoId)),
        collapsedGroups: new Set(ui.collapsedGroups ?? []),
        uiZoomLevel: ui.uiZoomLevel ?? 0,
        editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
        worktreeCardProperties: ui.worktreeCardProperties ?? [...DEFAULT_WORKTREE_CARD_PROPERTIES],
        statusBarItems: ui.statusBarItems ?? [...DEFAULT_STATUS_BAR_ITEMS],
        statusBarVisible: ui.statusBarVisible ?? true,
        dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
        updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
        browserDefaultUrl: ui.browserDefaultUrl ?? null,
        browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
        trustedOrcaHooks: filterTrustedOrcaHooksToValidRepos(
          ui.trustedOrcaHooks ?? {},
          validRepoIds
        ),
        persistedUIReady: true
      }
    }),

  updateStatus: { state: 'idle' },
  setUpdateStatus: (status) => {
    const prevState = get().updateStatus.state
    const update: Partial<
      Pick<UISlice, 'updateStatus' | 'updateChangelog' | 'updateCardCollapsed'>
    > = {
      updateStatus: status
    }
    if (status.state === 'available') {
      // Why: cache changelog from each 'available' payload so the card retains
      // rich content across downloading/error/downloaded transitions. Always
      // overwrite (even with null) to prevent a previous rich changelog from
      // leaking into a later simple-mode update for a different version.
      update.updateChangelog = status.changelog ?? null
    } else if (
      status.state === 'idle' ||
      status.state === 'checking' ||
      status.state === 'not-available'
    ) {
      // Why: reset on cycle-boundary states so stale rich content from a
      // previous update cycle cannot resurface.
      update.updateChangelog = null
    }
    // For 'downloading', 'downloaded', 'error': leave updateChangelog untouched
    // so the card can keep showing rich content from the original 'available'.
    if (status.state !== prevState) {
      // Why: re-surface the card on every phase transition so a prior collapse
      // of `downloading` doesn't bury the `downloaded`/`error` that follows.
      update.updateCardCollapsed = false
    }
    set(update)
  },
  updateChangelog: null,
  dismissedUpdateVersion: null,
  clearDismissedUpdateVersion: () => {
    set({ dismissedUpdateVersion: null })
  },
  dismissUpdate: (versionOverride?: string) =>
    set((s) => {
      // Why: the 'error' variant has no version field, so the card passes
      // the cached version explicitly via versionOverride.
      const dismissedUpdateVersion =
        versionOverride ?? ('version' in s.updateStatus ? (s.updateStatus.version ?? null) : null)
      const activeNudgeId =
        'activeNudgeId' in s.updateStatus ? (s.updateStatus.activeNudgeId ?? null) : null
      // Why: dismissing an update is user intent, not transient view state. Persist
      // the dismissed version so relaunching the app does not immediately re-show
      // the same reminder card until a newer release appears.
      void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error)
      // Why: only dismiss the main-process nudge campaign when the visible card
      // actually came from a nudge-driven update cycle. Ordinary update dismissals
      // must not consume the active campaign state.
      if (activeNudgeId) {
        void window.api.updater.dismissNudge().catch(console.error)
      }
      return { dismissedUpdateVersion }
    }),
  updateCardCollapsed: false,
  setUpdateCardCollapsed: (collapsed) => set({ updateCardCollapsed: collapsed }),
  updateReassuranceSeen: false,
  markUpdateReassuranceSeen: () => {
    void window.api.ui.set({ updateReassuranceSeen: true }).catch(console.error)
    set({ updateReassuranceSeen: true })
  },
  isFullScreen: false,
  setIsFullScreen: (v) => set({ isFullScreen: v }),
  browserDefaultUrl: null,
  setBrowserDefaultUrl: (url) => {
    void window.api.ui.set({ browserDefaultUrl: url }).catch(console.error)
    set({ browserDefaultUrl: url })
  },
  browserDefaultSearchEngine: null,
  setBrowserDefaultSearchEngine: (engine) => {
    void window.api.ui.set({ browserDefaultSearchEngine: engine }).catch(console.error)
    set({ browserDefaultSearchEngine: engine })
  }
})
