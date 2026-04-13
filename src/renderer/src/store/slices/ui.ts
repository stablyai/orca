import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  ChangelogData,
  PersistedUIState,
  StatusBarItem,
  UpdateStatus,
  WorktreeCardProperty
} from '../../../../shared/types'
import {
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES
} from '../../../../shared/constants'

type LegacyPersistedSortBy = PersistedUIState['sortBy'] | 'smart'

const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 500

function sanitizePersistedSidebarWidth(width: unknown, fallback: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

export type UISlice = {
  sidebarOpen: boolean
  sidebarWidth: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  activeView: 'terminal' | 'settings'
  setActiveView: (view: UISlice['activeView']) => void
  settingsNavigationTarget: {
    pane: 'general' | 'appearance' | 'terminal' | 'shortcuts' | 'repo'
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
  modalData: Record<string, unknown>
  openModal: (modal: UISlice['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  groupBy: 'none' | 'repo' | 'pr-status'
  setGroupBy: (g: UISlice['groupBy']) => void
  sortBy: 'name' | 'recent' | 'repo'
  setSortBy: (s: UISlice['sortBy']) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  filterRepoIds: string[]
  setFilterRepoIds: (ids: string[]) => void
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
  updateReassuranceSeen: boolean
  markUpdateReassuranceSeen: () => void
  isFullScreen: boolean
  setIsFullScreen: (v: boolean) => void
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  sidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  activeView: 'terminal',
  setActiveView: (view) => set({ activeView: view }),
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
      const sortBy = (ui.sortBy as LegacyPersistedSortBy) === 'smart' ? 'recent' : ui.sortBy
      return {
        // Why: persisted UI data comes from disk and may be stale, corrupted,
        // or manually edited. Clamp widths during hydration so invalid values
        // cannot push the renderer into broken layouts before the user drags a
        // sidebar again.
        sidebarWidth: sanitizePersistedSidebarWidth(ui.sidebarWidth, s.sidebarWidth),
        rightSidebarWidth: sanitizePersistedSidebarWidth(ui.rightSidebarWidth, s.rightSidebarWidth),
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
        persistedUIReady: true
      }
    }),

  updateStatus: { state: 'idle' },
  setUpdateStatus: (status) => {
    const update: Partial<Pick<UISlice, 'updateStatus' | 'updateChangelog'>> = {
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
  updateReassuranceSeen: false,
  markUpdateReassuranceSeen: () => {
    void window.api.ui.set({ updateReassuranceSeen: true }).catch(console.error)
    set({ updateReassuranceSeen: true })
  },
  isFullScreen: false,
  setIsFullScreen: (v) => set({ isFullScreen: v })
})
