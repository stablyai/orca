import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { worktreePassesSidebarFilters } from './worktree-filter-visibility'

const TWIN_ID = 'repo-1::/projects/app'

function makeTwin(hostId?: string): Worktree {
  return {
    id: TWIN_ID,
    repoId: 'repo-1',
    path: '/projects/app',
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'app',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...(hostId ? { hostId } : {})
  } as Worktree
}

// STA-4343: the same worktree id names one workspace per host; only the local
// twin passes a local-only host scope.
function stateWithLocalScopedTwins(): unknown {
  return {
    repos: [
      { id: 'repo-1', path: '/projects/app', displayName: 'app', badgeColor: '', addedAt: 1 }
    ],
    worktreesByRepo: { 'repo-1': [makeTwin(), makeTwin('ssh:beta')] },
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    agentStatusByPaneKey: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    workspaceHostScope: 'local',
    visibleWorkspaceHostIds: ['local'],
    settings: null,
    worktreeLineageById: {}
  }
}

describe('worktreePassesSidebarFilters', () => {
  it('does not let a visible local twin vouch for a host-filtered remote target', () => {
    mocks.getState.mockReturnValue(stateWithLocalScopedTwins())

    expect(worktreePassesSidebarFilters(TWIN_ID, 'ssh:beta')).toBe(false)
    expect(worktreePassesSidebarFilters(TWIN_ID, 'local')).toBe(true)
    // Host unknown to the caller: id-only match keeps prior behavior.
    expect(worktreePassesSidebarFilters(TWIN_ID)).toBe(true)
  })

  it('reports the remote twin visible when its host is in scope', () => {
    const state = stateWithLocalScopedTwins() as { visibleWorkspaceHostIds: string[] }
    state.visibleWorkspaceHostIds = ['ssh:beta']
    mocks.getState.mockReturnValue(state)

    expect(worktreePassesSidebarFilters(TWIN_ID, 'ssh:beta')).toBe(true)
    expect(worktreePassesSidebarFilters(TWIN_ID, 'local')).toBe(false)
  })
})
