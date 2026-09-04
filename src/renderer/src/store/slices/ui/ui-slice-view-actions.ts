import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import type { SessionGridFilter } from '../../../../../shared/session-grid-types'
import { toggleSessionGridHiddenTabId } from '../session-grid-hidden-tabs'
import { rewindHistoryIndexPastView } from '../worktree-nav-history'
import { clampSessionGridZoom } from '../session-grid-zoom'

const CLEARED_SESSION_GRID_SELECTION = { activeSessionGridTabId: null } as const

/** Hiding the picked card takes it off the board; showing another one leaves the pick alone. */
function clearedSelectionBuriedBy(
  state: Pick<UISlice, 'activeSessionGridTabId'>,
  hiddenTabIds: readonly string[]
): { activeSessionGridTabId?: null } {
  return state.activeSessionGridTabId && hiddenTabIds.includes(state.activeSessionGridTabId)
    ? CLEARED_SESSION_GRID_SELECTION
    : {}
}

export function createUiViewActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    openActivityPage: () => {
      set((state) => ({
        activeView: 'activity',
        previousViewBeforeActivity:
          state.activeView === 'activity' ? state.previousViewBeforeActivity : state.activeView
      }))
    },
    closeActivityPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeActivity
      })),
    selectedAutomationId: null,
    setSelectedAutomationId: (id) => set({ selectedAutomationId: id }),
    pendingAutomationRunNavigation: null,
    setPendingAutomationRunNavigation: (navigation) =>
      set({ pendingAutomationRunNavigation: navigation }),
    openAutomationsPage: () => {
      get().recordViewVisit('automations')
      set((state) => ({
        activeView: 'automations',
        previousViewBeforeAutomations:
          state.activeView === 'automations'
            ? state.previousViewBeforeAutomations
            : state.activeView
      }))
    },
    closeAutomationsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeAutomations,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'automations')
      })),
    openSpacePage: () => {
      get().recordFeatureInteraction?.('workspace-cleanup')
      set((state) => ({
        activeView: 'space',
        previousViewBeforeSpace:
          state.activeView === 'space' ? state.previousViewBeforeSpace : state.activeView
      }))
    },
    closeSpacePage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSpace
      })),
    openSkillsPage: () => {
      get().recordViewVisit('skills')
      set((state) => ({
        activeView: 'skills',
        previousViewBeforeSkills:
          state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView
      }))
    },
    closeSkillsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSkills,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'skills')
      })),
    openSkillShare: (shareId) => {
      get().recordViewVisit('skills')
      set((state) => ({
        activeView: 'skills',
        previousViewBeforeSkills:
          state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
        pendingSkillShareId: shareId
      }))
    },
    clearPendingSkillShare: () => set({ pendingSkillShareId: null }),
    openSkillsSharedLinks: () => {
      get().recordViewVisit('skills')
      set((state) => ({
        activeView: 'skills',
        previousViewBeforeSkills:
          state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
        pendingSkillsSharedView: true
      }))
    },
    clearPendingSkillsSharedView: () => set({ pendingSkillsSharedView: false }),
    openArtifactsPage: () => {
      get().recordViewVisit('artifacts')
      set((state) => ({
        activeView: 'artifacts',
        previousViewBeforeArtifacts:
          state.activeView === 'artifacts' ? state.previousViewBeforeArtifacts : state.activeView
      }))
    },
    closeArtifactsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeArtifacts,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'artifacts')
      })),
    openMobilePage: () =>
      set((state) => ({
        activeView: 'mobile',
        previousViewBeforeMobile:
          state.activeView === 'mobile' ? state.previousViewBeforeMobile : state.activeView
      })),
    closeMobilePage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeMobile
      })),
    openSessionsPage: () => {
      get().recordViewVisit('sessions')
      set((state) => ({
        activeView: 'sessions',
        previousViewBeforeSessions:
          state.activeView === 'sessions' ? state.previousViewBeforeSessions : state.activeView
      }))
    },
    closeSessionsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSessions,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'sessions')
      })),
    setSessionsGridPreset: (preset) => set({ sessionsGridPreset: preset }),
    setSessionsGridZoom: (zoom) => set({ sessionsGridZoom: clampSessionGridZoom(zoom) }),
    toggleSessionsGridShowEmpty: () =>
      set((state) => ({ sessionsGridShowEmpty: !state.sessionsGridShowEmpty })),
    // Both axes re-query the board, and the picked card may not survive the answer. Clearing in
    // the same write is what keeps the auto-ack scan from seeing the old pick under the new
    // query — a second write would publish that pairing to every listener first.
    setSessionsGridFilter: (filter: SessionGridFilter) =>
      set({ sessionsGridFilter: filter, ...CLEARED_SESSION_GRID_SELECTION }),
    setSessionsGridStateFilter: (filter) =>
      set({ sessionsGridStateFilter: filter, ...CLEARED_SESSION_GRID_SELECTION }),
    setSessionsGridScrollMode: (mode) => set({ sessionsGridScrollMode: mode }),
    setSessionsGridWheelTarget: (target) => set({ sessionsGridWheelTarget: target }),
    setSessionsGridTabOrder: (order) => set({ sessionsGridTabOrder: order }),
    setSessionsGridHiddenTabIds: (tabIds) =>
      set((state) => ({
        sessionsGridHiddenTabIds: tabIds,
        ...clearedSelectionBuriedBy(state, tabIds)
      })),
    toggleSessionsGridHiddenTab: (tabId) =>
      set((state) => {
        const sessionsGridHiddenTabIds = toggleSessionGridHiddenTabId(
          state.sessionsGridHiddenTabIds,
          tabId
        )
        return {
          sessionsGridHiddenTabIds,
          ...clearedSelectionBuriedBy(state, sessionsGridHiddenTabIds)
        }
      }),
    setActiveSessionGridTabId: (tabId) => set({ activeSessionGridTabId: tabId }),
    setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
    clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null })
  }
}
