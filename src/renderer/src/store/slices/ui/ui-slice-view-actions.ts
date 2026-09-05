import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { rewindHistoryIndexPastView } from '../worktree-nav-history'
import {
  EMPTY_WORKSPACE_MULTIPLEXER_STATE,
  normalizeWorkspaceMultiplexerState
} from '../../../../../shared/workspace-multiplexer-types'

export function createUiViewActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    workspaceMultiplexer: EMPTY_WORKSPACE_MULTIPLEXER_STATE,
    setWorkspaceMultiplexer: (multiplexer) => {
      const normalized = normalizeWorkspaceMultiplexerState(multiplexer)
      set({ workspaceMultiplexer: normalized })
      window.api.ui.set({ workspaceMultiplexer: normalized }).catch(console.error)
    },
    openWorkspaceMultiplexer: () =>
      set((state) => ({
        activeView: 'multiplexer',
        previousViewBeforeMultiplexer:
          state.activeView === 'multiplexer'
            ? state.previousViewBeforeMultiplexer
            : state.activeView
      })),
    closeWorkspaceMultiplexer: () =>
      set((state) => ({
        activeView: state.previousViewBeforeMultiplexer
      })),
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
    setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
    clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null })
  }
}
