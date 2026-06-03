import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/feature',
    repoId: 'repo-1',
    path: '/workspace/feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdWithAgent: 'codex'
  }
}

function seedAlreadyActiveWorktree(
  worktree: Worktree,
  overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}
): {
  markWorktreeVisited: ReturnType<typeof vi.fn>
  recordWorktreeVisit: ReturnType<typeof vi.fn>
  revealWorktreeInSidebar: ReturnType<typeof vi.fn>
} {
  const markWorktreeVisited = vi.fn()
  const recordWorktreeVisit = vi.fn()
  const revealWorktreeInSidebar = vi.fn()

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
    tabsByWorktree: {
      [worktree.id]: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: worktree.id,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    unifiedTabsByWorktree: {
      [worktree.id]: [
        {
          id: 'tab-1',
          entityId: 'tab-1',
          groupId: 'group-1',
          worktreeId: worktree.id,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [worktree.id]: [
        {
          id: 'group-1',
          worktreeId: worktree.id,
          activeTabId: 'tab-1',
          tabOrder: ['tab-1']
        }
      ]
    },
    activeGroupIdByWorktree: { [worktree.id]: 'group-1' },
    activeTabTypeByWorktree: { [worktree.id]: 'terminal' },
    everActivatedWorktreeIds: new Set([worktree.id]),
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabIdByWorktree: { [worktree.id]: 'tab-1' },
    tabBarOrderByWorktree: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
    markWorktreeVisited,
    recordWorktreeVisit,
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar,
    ...overrides
  })

  return { markWorktreeVisited, recordWorktreeVisit, revealWorktreeInSidebar }
}

describe('activateAndRevealWorktree created agent reopen', () => {
  it('does not restamp focus recency when reselecting the already-active terminal worktree', () => {
    const worktree = makeWorktree()
    const { markWorktreeVisited, recordWorktreeVisit, revealWorktreeInSidebar } =
      seedAlreadyActiveWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id)

    expect(result).toEqual({ primaryTabId: null })
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })

  it('records a visit when activating the same worktree changes the current view', () => {
    const worktree = makeWorktree()
    const { markWorktreeVisited, recordWorktreeVisit } = seedAlreadyActiveWorktree(worktree, {
      activeView: 'tasks'
    })

    const result = activateAndRevealWorktree(worktree.id)

    expect(result).toEqual({ primaryTabId: null })
    expect(markWorktreeVisited).toHaveBeenCalledWith(worktree.id)
    expect(recordWorktreeVisit).toHaveBeenCalledWith(worktree.id)
  })

  it('reopens an empty worktree with the agent selected at creation time', () => {
    const worktree = makeWorktree()
    const revealWorktreeInSidebar = vi.fn()

    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
      activeRepoId: 'repo-1',
      activeView: 'terminal',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabIdByWorktree: {},
      tabBarOrderByWorktree: {},
      pendingStartupByTabId: {},
      settings: {
        agentCmdOverrides: {},
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar
    })

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(result).toEqual({ primaryTabId: reopenedTab?.id })
    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toEqual({
      command: 'codex',
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    })
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })

  it('forwards an explicit sidebar reveal behavior', () => {
    const worktree = makeWorktree()
    const revealWorktreeInSidebar = vi.fn()

    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
      activeRepoId: 'repo-1',
      activeView: 'terminal',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabIdByWorktree: {},
      tabBarOrderByWorktree: {},
      pendingStartupByTabId: {},
      settings: {
        agentCmdOverrides: {},
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar
    })

    const result = activateAndRevealWorktree(worktree.id, { sidebarRevealBehavior: 'auto' })

    expect(result).toEqual({ primaryTabId: expect.any(String) })
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id, { behavior: 'auto' })
  })

  it('asks the host runtime to activate the worktree in the paired web client', async () => {
    const worktree = makeWorktree()
    const callRuntimeEnvironment = vi.fn().mockResolvedValue({
      ok: true,
      result: { repoId: worktree.repoId, worktreeId: worktree.id, activated: true }
    })
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: callRuntimeEnvironment
        }
      }
    })

    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
      activeRepoId: 'repo-1',
      activeView: 'terminal',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabIdByWorktree: {},
      tabBarOrderByWorktree: {},
      settings: {
        agentCmdOverrides: {},
        activeRuntimeEnvironmentId: 'web-runtime-1',
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    })

    const result = activateAndRevealWorktree(worktree.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().activeWorktreeId).toBe(worktree.id)
    expect(callRuntimeEnvironment).toHaveBeenCalledWith({
      selector: 'web-runtime-1',
      method: 'worktree.activate',
      params: { worktree: `id:${worktree.id}` },
      timeoutMs: 15_000
    })
  })
})
