import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  activateAndRevealWorkspace,
  activateAndRevealWorktree,
  activateAndRevealWorkspaceWithOutcome
} from './worktree-activation'
import { reportAgentWorkspaceActivation } from './worktree-activation-outcome'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import './workspace-switch-user-act'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  vi.clearAllMocks()
})

function makeAutomationWorktree() {
  return makeWorktree({
    id: 'repo-1::/workspace/automation-run',
    repoId: 'repo-1',
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
  })
}

function seedAutomationWorktreeState(
  worktree: ReturnType<typeof makeWorktree>,
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
  it.each(['folder:removed', 'removed-worktree'])(
    'returns an unreported refusal for missing %s and leaves existing selection alone',
    (id) => {
      useAppStore.setState({ folderWorkspaces: [], worktreesByRepo: {} })
      const before = useAppStore.getState().activeWorktreeId
      const outcome = activateAndRevealWorkspaceWithOutcome(id)
      expect(outcome).toEqual({ refused: { reason: 'workspace-missing', failureNotified: false } })
      expect(toastError).not.toHaveBeenCalled()
      expect(reportAgentWorkspaceActivation(outcome, 'claude')).toBe(false)
      expect(toastError).toHaveBeenCalledOnce()
      expect(useAppStore.getState().activeWorktreeId).toBe(before)
    }
  )

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

    const outcome = activateAndRevealWorkspaceWithOutcome('folder:folder-1', {
      showWorkspaceList: true
    })
    expect(outcome).toEqual({ refused: { reason: 'path-blocked', failureNotified: true } })
    expect(reportAgentWorkspaceActivation(outcome, 'claude')).toBe(false)
    expect(toastError).toHaveBeenCalledOnce()
    expect(activateAndRevealWorkspace('folder:folder-1', { showWorkspaceList: true })).toBe(false)
    expect(getFreshFolderWorkspacePathStatus).toHaveBeenCalled()
    expect(useAppStore.getState().sidebarBody).toBe('agents')
  })
})
