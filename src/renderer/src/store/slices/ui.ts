import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PersistedUIState, UpdateStatus, WorktreeCardProperty } from '../../../../shared/types'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../shared/constants'

type LegacyPersistedSortBy = PersistedUIState['sortBy'] | 'smart'

export type UISlice = {
  sidebarOpen: boolean
  sidebarWidth: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  activeView: 'terminal' | 'settings'
  setActiveView: (view: UISlice['activeView']) => void
  activeModal: 'none' | 'create-worktree' | 'edit-meta' | 'delete-worktree'
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
  pendingRevealWorktreeId: string | null
  revealWorktreeInSidebar: (worktreeId: string) => void
  clearPendingRevealWorktreeId: () => void
  persistedUIReady: boolean
  hydratePersistedUI: (ui: PersistedUIState) => void
  updateStatus: UpdateStatus
  setUpdateStatus: (status: UpdateStatus) => void
  dismissedUpdateVersion: string | null
  dismissUpdate: () => void
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  sidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  activeView: 'terminal',
  setActiveView: (view) => set({ activeView: view }),

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

  pendingRevealWorktreeId: null,
  revealWorktreeInSidebar: (worktreeId) => set({ pendingRevealWorktreeId: worktreeId }),
  clearPendingRevealWorktreeId: () => set({ pendingRevealWorktreeId: null }),
  persistedUIReady: false,

  hydratePersistedUI: (ui) =>
    set((s) => {
      const validRepoIds = new Set(s.repos.map((repo) => repo.id))
      const sortBy = (ui.sortBy as LegacyPersistedSortBy) === 'smart' ? 'recent' : ui.sortBy
      return {
        sidebarWidth: ui.sidebarWidth,
        rightSidebarWidth: ui.rightSidebarWidth ?? 280,
        groupBy: ui.groupBy,
        sortBy,
        filterRepoIds: (ui.filterRepoIds ?? []).filter((repoId) => validRepoIds.has(repoId)),
        worktreeCardProperties: ui.worktreeCardProperties ?? [...DEFAULT_WORKTREE_CARD_PROPERTIES],
        dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
        persistedUIReady: true
      }
    }),

  updateStatus: { state: 'idle' },
  setUpdateStatus: (status) => set({ updateStatus: status }),
  dismissedUpdateVersion: null,
  dismissUpdate: () =>
    set((s) => {
      const dismissedUpdateVersion =
        'version' in s.updateStatus ? (s.updateStatus.version ?? null) : null
      // Why: dismissing an update is user intent, not transient view state. Persist
      // the dismissed version so relaunching the app does not immediately re-show
      // the same reminder card until a newer release appears.
      void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error)
      return { dismissedUpdateVersion }
    })
})
