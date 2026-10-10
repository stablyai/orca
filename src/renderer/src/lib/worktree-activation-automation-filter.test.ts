import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeAutomationWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/automation-run',
    repoId: 'repo-1',
    path: '/workspace/automation-run',
    head: 'abc123',
    branch: 'refs/heads/automation-run',
    isBare: false,
    isMainWorktree: false,
    displayName: 'automation-run',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'automation-1',
      automationNameSnapshot: 'Nightly review',
      automationRunId: 'run-1',
      automationRunTitleSnapshot: 'Nightly review run',
      createdAt: 123,
      executionTargetType: 'local',
      executionTargetId: 'local',
      projectId: 'repo-1',
      repoId: 'repo-1',
      hostId: 'local'
    }
  }
}

function seedAutomationWorktreeState(
  worktree: Worktree,
  overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}
): void {
  useAppStore.setState({
    repos: [
      {
        id: worktree.repoId,
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    activeRepoId: worktree.repoId,
    activeView: 'terminal',
    activeWorktreeId: worktree.id,
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabsByWorktree: { [worktree.id]: [] },
    ptyIdsByTabId: {},
    everActivatedWorktreeIds: new Set([worktree.id]),
    hideAutomationGeneratedWorkspaces: true,
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    ...overrides
  })
}

describe('activateAndRevealWorktree automation filters', () => {
  it('clears the automation-generated filter before revealing an automation-created worktree', () => {
    const worktree = makeAutomationWorktree()
    const revealWorktreeInSidebar = vi.fn()
    seedAutomationWorktreeState(worktree, { revealWorktreeInSidebar })

    activateAndRevealWorktree(worktree.id)

    expect(useAppStore.getState().hideAutomationGeneratedWorkspaces).toBe(false)
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })

  it('keeps workspace-list filters while the activity view is showing', () => {
    const worktree = makeAutomationWorktree()
    seedAutomationWorktreeState(worktree, {
      sidebarBody: 'agents',
      filterRepoIds: ['other-repo']
    })

    activateAndRevealWorktree(worktree.id)

    const state = useAppStore.getState()
    expect(state.hideAutomationGeneratedWorkspaces).toBe(true)
    expect(state.filterRepoIds).toEqual(['other-repo'])
    expect(state.sidebarBody).toBe('agents')
    expect(state.pendingRevealWorktree).toBeNull()
  })

  it('leaves the activity view to lift filters and reveal when the caller asks for the list', () => {
    const worktree = makeAutomationWorktree()
    seedAutomationWorktreeState(worktree, { sidebarBody: 'agents' })

    activateAndRevealWorktree(worktree.id, { showWorkspaceList: true })

    const state = useAppStore.getState()
    expect(state.sidebarBody).toBe('workspaces')
    expect(state.hideAutomationGeneratedWorkspaces).toBe(false)
    expect(state.pendingRevealWorktree?.worktreeId).toBe(worktree.id)
  })

  it('stays in the activity view when a blocked folder activation fails', () => {
    const getFreshFolderWorkspacePathStatus = vi.fn(() => ({
      path: '/gone',
      exists: false,
      reason: 'missing' as const
    }))
    useAppStore.setState({
      sidebarBody: 'agents',
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'gone',
          folderPath: '/gone',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getFreshFolderWorkspacePathStatus
    })

    expect(activateAndRevealWorkspace('folder:folder-1', { showWorkspaceList: true })).toBe(false)
    expect(getFreshFolderWorkspacePathStatus).toHaveBeenCalled()
    expect(useAppStore.getState().sidebarBody).toBe('agents')
  })
})
