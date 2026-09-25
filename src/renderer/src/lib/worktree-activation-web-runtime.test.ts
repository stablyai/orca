import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import type { AppStoreState } from './worktree-activation-test-harness'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'
import { useAppStore } from '@/store'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent-test-state'
import {
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'

registerWorktreeActivationReset()

afterEach(() => {
  vi.unstubAllGlobals()
  resetWebRuntimeWakeTerminalRespawnForTests()
})

describe('activateAndRevealWorktree', () => {
  it('asks the paired host for the prepared agent terminal when backend startup did not spawn', async () => {
    const worktree = {
      ...makeCreatedAgentWorktree(),
      hostId: 'local' as const,
      runtimeOwnerEnvironmentId: 'web-runtime-1'
    }
    const callRuntimeEnvironment = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) =>
        request.method === 'session.tabs.createTerminal'
          ? {
              ok: true,
              result: {
                tab: { id: 'host-agent-tab', leafId: 'host-agent-leaf' },
                publicationEpoch: 'epoch-1',
                snapshotVersion: 1
              }
            }
          : { ok: false, error: { code: 'test', message: 'stop after recording the request' } }
    )
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: callRuntimeEnvironment } }
    })
    seedEmptyActivatableWorktree(worktree)
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      settings: settings
        ? { ...settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof settings)
    })
    useAppStore.setState({
      tabsByWorktree: {
        [worktree.id]: [
          {
            id: 'stale-local-agent-tab',
            ptyId: 'stale-local-agent-pty',
            worktreeId: worktree.id,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'codex'
          }
        ]
      }
    })

    activateAndRevealWorktree(worktree.id, {
      agent: 'codex',
      startup: {
        command: "codex 'fix the ownership race'",
        env: { ORCA_AGENT_PROFILE: 'review' },
        launchAgent: 'codex',
        launchToken: 'launch-1'
      }
    })
    await vi.waitFor(() =>
      expect(callRuntimeEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'worktree.activate' })
      )
    )

    const createRequests = callRuntimeEnvironment.mock.calls.filter(
      ([request]) => request.method === 'session.tabs.createTerminal'
    )
    expect(createRequests).toHaveLength(1)
    expect(createRequests[0]?.[0]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          command: "codex 'fix the ownership race'",
          env: { ORCA_AGENT_PROFILE: 'review' },
          launchAgent: 'codex',
          launchToken: 'launch-1'
        })
      })
    )
    await vi.waitFor(() => expect(shouldSkipWebRuntimeWakeTerminalRespawn(worktree.id)).toBe(false))
  })

  it('does not request another host terminal when backend startup already spawned', async () => {
    const worktree = {
      ...makeCreatedAgentWorktree(),
      hostId: 'local' as const,
      runtimeOwnerEnvironmentId: 'web-runtime-1'
    }
    const callRuntimeEnvironment = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'test', message: 'stop after recording the request' }
    })
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: callRuntimeEnvironment } }
    })
    seedEmptyActivatableWorktree(worktree)
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings)
    }))

    activateAndRevealWorktree(worktree.id, {
      agent: 'codex',
      backendStartupTerminalSpawned: true
    })
    await vi.waitFor(() =>
      expect(callRuntimeEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'worktree.activate' })
      )
    )

    expect(
      callRuntimeEnvironment.mock.calls.filter(
        ([request]) => request.method === 'session.tabs.createTerminal'
      )
    ).toHaveLength(0)
  })
})

describe('activateAndRevealFolderWorkspace', () => {
  it.each([
    [
      'the selected agent',
      {
        agent: 'codex' as const,
        startup: { command: 'codex', launchAgent: 'codex' as const, launchToken: 'launch-1' }
      },
      { command: 'codex', launchAgent: 'codex', launchToken: 'launch-1' }
    ],
    ['Blank Terminal', { agent: null }, { command: undefined }]
  ])('asks the runtime owner for exactly one %s surface', async (_label, activation, expected) => {
    const callRuntimeEnvironment = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) =>
        request.method === 'session.tabs.createTerminal'
          ? {
              ok: true,
              result: {
                tab: { id: 'host-tab', leafId: 'host-leaf' },
                publicationEpoch: 'epoch-1',
                snapshotVersion: 1
              }
            }
          : { ok: false, error: { code: 'test', message: 'stop after recording the request' } }
    )
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: callRuntimeEnvironment } }
    })
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      activeView: 'terminal',
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'runtime folder',
          folderPath: '/workspace/runtime-folder',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          executionHostId: 'runtime:web-runtime-1'
        }
      ],
      getFreshFolderWorkspacePathStatus: vi.fn(() => ({ exists: true })),
      tabsByWorktree: {},
      settings: settings
        ? { ...settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof settings),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    } as unknown as Partial<AppStoreState>)

    activateAndRevealFolderWorkspace('folder-1', {
      ...activation,
      runtimeEnvironmentId: 'web-runtime-1'
    })

    await vi.waitFor(() =>
      expect(
        callRuntimeEnvironment.mock.calls.filter(
          ([request]) => request.method === 'session.tabs.createTerminal'
        )
      ).toHaveLength(1)
    )
    const createRequest = callRuntimeEnvironment.mock.calls.find(
      ([request]) => request.method === 'session.tabs.createTerminal'
    )?.[0]
    expect(createRequest).toEqual(
      expect.objectContaining({
        params: expect.objectContaining(expected)
      })
    )
    if (activation.agent === null) {
      expect(createRequest?.params).not.toHaveProperty('launchAgent')
    }
    await vi.waitFor(() =>
      expect(shouldSkipWebRuntimeWakeTerminalRespawn('folder:folder-1')).toBe(false)
    )
  })
})

describe('ensureWorktreeHasInitialTerminal', () => {
  it('does not create a local fallback tab in the paired web runtime client', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('queues returned setup fallback on an existing web runtime tab', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    let createdIndex = 1
    const createTab = vi.fn(() => ({ id: `tab-${++createdIndex}` }))
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      createTab,
      settings: { activeRuntimeEnvironmentId: 'web-runtime-1' },
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 }))
    })

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      { command: 'claude' },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' },
        waitForAgentStartup: true
      }
    )

    expect(result).toBe('tab-1')
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-2',
      expect.objectContaining({
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh')
      })
    )
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-2',
      expect.objectContaining({
        command: expect.stringContaining('printf')
      })
    )
  })

  it('holds the issue command for the first mirrored web runtime tab when none exists yet', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    useAppStore.setState({
      tabsByWorktree: {},
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      command: 'gh issue view 42'
    })

    // Why: runtime session tabs mirror in asynchronously — the command must be
    // held for the first mirrored tab rather than silently dropped.
    expect(result).toBeNull()
    expect(useAppStore.getState().pendingIssueCommandSplitByTabId).toEqual({})

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })

  it('does not create a fallback while a backend startup terminal awaits mirroring', () => {
    useAppStore.setState({
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      { command: 'gh issue view 42' },
      undefined,
      { backendStartupTerminalSpawned: true }
    )

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })

  it('creates a local initial terminal for explicitly local worktrees while a runtime is focused', () => {
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings)
    }))
    const store = createMockStore({
      settings: { activeRuntimeEnvironmentId: 'web-runtime-1' },
      repos: [{ id: 'repo-1', executionHostId: 'local', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    })

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(result).toBe('tab-1')
    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
  })
})
