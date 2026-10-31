import { beginDesktopNavigation, commitDesktopNavigation } from '@/lib/desktop-navigation-request'
import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { rewindHistoryIndexPastView } from '../worktree-nav-history'

export function createUiViewActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    openActivityPage: () => {
      const navigation = beginDesktopNavigation(get())
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'activity',
          previousViewBeforeActivity:
            state.activeView === 'activity' ? state.previousViewBeforeActivity : state.activeView
        }))
      )
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
      const navigation = beginDesktopNavigation(get())
      get().recordViewVisit('automations')
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'automations',
          previousViewBeforeAutomations:
            state.activeView === 'automations'
              ? state.previousViewBeforeAutomations
              : state.activeView
        }))
      )
    },
    closeAutomationsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeAutomations,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'automations')
      })),
    openSpacePage: () => {
      get().recordFeatureInteraction?.('workspace-cleanup')
      if (typeof window !== 'undefined' && window.api?.workspaceSpace?.openWindow) {
        void window.api.workspaceSpace.openWindow()
        return
      }
      const navigation = beginDesktopNavigation(get())
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'space',
          previousViewBeforeSpace:
            state.activeView === 'space' ? state.previousViewBeforeSpace : state.activeView
        }))
      )
    },
    closeSpacePage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSpace
      })),
    openSkillsPage: () => {
      const navigation = beginDesktopNavigation(get())
      get().recordViewVisit('skills')
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'skills',
          previousViewBeforeSkills:
            state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView
        }))
      )
    },
    closeSkillsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeSkills,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'skills')
      })),
    openSkillShare: (shareId) => {
      const navigation = beginDesktopNavigation(get())
      get().recordViewVisit('skills')
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'skills',
          previousViewBeforeSkills:
            state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
          pendingSkillShareId: shareId
        }))
      )
    },
    clearPendingSkillShare: () => set({ pendingSkillShareId: null }),
    openSkillsSharedLinks: () => {
      const navigation = beginDesktopNavigation(get())
      get().recordViewVisit('skills')
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'skills',
          previousViewBeforeSkills:
            state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
          pendingSkillsSharedView: true
        }))
      )
    },
    clearPendingSkillsSharedView: () => set({ pendingSkillsSharedView: false }),
    openArtifactsPage: () => {
      const navigation = beginDesktopNavigation(get())
      get().recordViewVisit('artifacts')
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'artifacts',
          previousViewBeforeArtifacts:
            state.activeView === 'artifacts' ? state.previousViewBeforeArtifacts : state.activeView
        }))
      )
    },
    closeArtifactsPage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeArtifacts,
        worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'artifacts')
      })),
    openMobilePage: () => {
      const navigation = beginDesktopNavigation(get())
      commitDesktopNavigation(navigation, () =>
        set((state) => ({
          activeView: 'mobile',
          previousViewBeforeMobile:
            state.activeView === 'mobile' ? state.previousViewBeforeMobile : state.activeView
        }))
      )
    },
    closeMobilePage: () =>
      set((state) => ({
        activeView: state.previousViewBeforeMobile
      })),
    setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
    clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null })
  }
}
