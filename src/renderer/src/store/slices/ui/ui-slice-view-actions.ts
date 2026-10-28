import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { rewindHistoryIndexPastView } from '../worktree-nav-history'

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
      if (typeof window !== 'undefined' && window.api?.workspaceSpace?.openWindow) {
        void window.api.workspaceSpace.openWindow()
        return
      }
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
    openWorktreeDeepLink: (link) => {
      if (link.type === 'worktree-create') {
        const stateWithRepos = get() as UISlice & {
          repos?: ReadonlyArray<{ id: string; displayName?: string; path?: string }>
        }
        const repos = stateWithRepos.repos ?? []
        const rawRepo = link.repo?.trim()
        const matchedRepo = rawRepo
          ? (repos.find((r) => r.id === rawRepo) ??
            repos.find((r) => r.displayName?.toLowerCase() === rawRepo.toLowerCase()) ??
            repos.find(
              (r) =>
                r.path
                  ?.split(/[\\/]/)
                  .filter(Boolean)
                  .pop()
                  ?.toLowerCase() === rawRepo.toLowerCase()
            ) ??
            null)
          : null
        const resolvedRepoId = matchedRepo?.id ?? (rawRepo && repos.length === 0 ? rawRepo : undefined)
        const unmatchedProjectId =
          rawRepo && repos.length > 0 && !matchedRepo ? rawRepo : undefined
        if (get().activeModal === 'new-workspace-composer') {
          get().closeModal()
        }
        get().openModal('new-workspace-composer', {
          prefilledName: link.name,
          initialRepoId: resolvedRepoId,
          ...(unmatchedProjectId
            ? { initialWorkspaceTarget: { projectId: unmatchedProjectId, hostId: 'local' } }
            : {}),
          initialBaseBranch: link.branch,
          telemetrySource: 'unknown'
        })
      }
    },
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
