import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
  getVisibleWorktreeShortcutTargets: vi.fn(),
  worktreePassesSidebarFilters: vi.fn(),
  warning: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/components/sidebar/visible-worktrees', () => ({
  getVisibleWorktreeShortcutTargets: mocks.getVisibleWorktreeShortcutTargets
}))
vi.mock('@/components/sidebar/worktree-filter-visibility', () => ({
  worktreePassesSidebarFilters: mocks.worktreePassesSidebarFilters
}))
vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }))

import { jumpToWorktreeFromSidebar } from './worktree-jump-navigation'

describe('worktree jump navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([])
    mocks.worktreePassesSidebarFilters.mockReturnValue(false)
    mocks.getState.mockReturnValue({
      sidebarBody: 'agents',
      setSidebarBody: vi.fn(),
      worktreesByRepo: { repo: [] },
      showSleepingWorkspaces: true,
      filterRepoIds: ['other-repo'],
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      alwaysShowDefaultBranchWorkspace: true,
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all',
      revealWorktreeInSidebar: vi.fn(),
      getKnownWorktreeById: vi.fn(() => ({ id: 'known' }))
    })
  })

  it('does not blame filters for a worktree that no longer exists', () => {
    // A retained agent row can outlive its (deleted) worktree; every filter check fails for
    // an unknown id, so without the existence guard any active filter would toast.
    const state = mocks.getState()
    state.getKnownWorktreeById.mockReturnValue(undefined)

    expect(jumpToWorktreeFromSidebar('repo::/deleted')).toBe(true)

    expect(mocks.worktreePassesSidebarFilters).not.toHaveBeenCalled()
    expect(mocks.warning).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('repo::/deleted', {})
  })

  it('switches the left sidebar to Spaces and warns when filters hide the target', () => {
    const state = mocks.getState()

    expect(jumpToWorktreeFromSidebar('repo::/target')).toBe(true)

    expect(state.setSidebarBody).toHaveBeenCalledWith('workspaces')
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('repo::/target', {
      revealInSidebar: false,
      clearSidebarFilters: false
    })
    expect(mocks.warning).toHaveBeenCalledOnce()
  })

  it('does not warn when the target is visible', () => {
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([{ id: 'wt-1' }])

    jumpToWorktreeFromSidebar('wt-1')

    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('reveals without warning when activation wakes a target hidden only by Hide sleeping', () => {
    const state = mocks.getState()
    mocks.worktreePassesSidebarFilters.mockReturnValueOnce(false).mockReturnValueOnce(true)

    expect(jumpToWorktreeFromSidebar('wt-sleeping')).toBe(true)

    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith('wt-sleeping', {})
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('reveals instead of warning when the target is only inside a collapsed group', () => {
    // Absent from the rendered list (collapse elision) but not excluded by filters.
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([])
    mocks.worktreePassesSidebarFilters.mockReturnValue(true)

    expect(jumpToWorktreeFromSidebar('wt-collapsed')).toBe(true)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-collapsed', {})
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('passes the target execution host to the filter check so a local twin cannot vouch', () => {
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([])
    mocks.worktreePassesSidebarFilters.mockReturnValue(false)

    expect(jumpToWorktreeFromSidebar('repo::/target', { executionHostId: 'ssh:beta' })).toBe(true)

    expect(mocks.worktreePassesSidebarFilters).toHaveBeenCalledWith('repo::/target', 'ssh:beta')
    expect(mocks.warning).toHaveBeenCalledOnce()
  })

  it('does not let a hostless legacy target vouch for a host-scoped one', () => {
    // Legacy rows publish without executionHostId; treating that as a match would clear the
    // user's filters instead of preserving them and warning.
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([{ id: 'repo::/target' }])
    mocks.worktreePassesSidebarFilters.mockReturnValue(false)

    expect(jumpToWorktreeFromSidebar('repo::/target', { executionHostId: 'ssh:beta' })).toBe(true)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('repo::/target', {
      revealInSidebar: false,
      clearSidebarFilters: false,
      executionHostId: 'ssh:beta'
    })
    expect(mocks.warning).toHaveBeenCalledOnce()
  })

  it('routes folder workspaces through the workspace dispatcher without a filter check', () => {
    const state = mocks.getState()

    expect(jumpToWorktreeFromSidebar('folder:folder-1', { executionHostId: 'local' })).toBe(true)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1', {
      executionHostId: 'local'
    })
    // Folder workspaces never get the filter-hidden treatment.
    expect(mocks.worktreePassesSidebarFilters).not.toHaveBeenCalled()
    expect(state.setSidebarBody).toHaveBeenCalledWith('workspaces')
  })

  it('propagates a blocked folder-workspace activation as failure', () => {
    const state = mocks.getState()
    mocks.activateAndRevealWorkspace.mockReturnValue(false)

    expect(jumpToWorktreeFromSidebar('folder:folder-1')).toBe(false)
    expect(state.setSidebarBody).not.toHaveBeenCalled()
  })
})
