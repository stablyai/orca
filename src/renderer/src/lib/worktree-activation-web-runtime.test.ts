import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV } from '../../../shared/setup-agent-sequencing'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import type { AppStoreState } from './worktree-activation.test-fixture'
import {
  createMockStore,
  registerWorktreeActivationReset,
  createdTabStartups
} from './worktree-activation.test-fixture'
import { useAppStore } from '@/store'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import {
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import { stubRuntimeEnvironmentBridge } from '../runtime/runtime-environment-bridge-fixture'
import { rememberEmptyHostAnswerForTests } from '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

import { createAutomationRunWorkspaceAction } from '../components/automations/automation-run-workspace-action'
import { resolveAutomationRunTarget } from '../components/automations/automation-run-open-target'
import { makeRun } from '../components/automations/automations-page-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../components/sidebar/folder-workspace-composer-submit-fixtures'
import { makePaneKey } from '../../../shared/stable-pane-id'

registerWorktreeActivationReset()
const originalCreateTab = useAppStore.getState().createTab
const originalSetActiveWorktree = useAppStore.getState().setActiveWorktree

afterEach(() => {
  useAppStore.setState({
    createTab: originalCreateTab,
    setActiveWorktree: originalSetActiveWorktree
  })
  vi.unstubAllGlobals()
  resetWebRuntimeWakeTerminalRespawnForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('activateAndRevealWorktree', () => {
  it.each(['local', 'runtime:recorded'] as const)(
    'historical reveal contract retains explicit %s owner and supplies no substitute terminal',
    async (hostId) => {
      const worktree = { ...makeCreatedAgentWorktree(), hostId }
      const twin = {
        ...worktree,
        hostId: hostId === 'local' ? ('runtime:other' as const) : ('local' as const)
      }
      seedEmptyActivatableWorktree(worktree, { extraWorktrees: [twin] })
      const createTab = vi.fn()
      const setActiveWorktree = vi.fn<typeof originalSetActiveWorktree>()
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'ambient-other' },
        createTab,
        setActiveWorktree,
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'ssh:unrelated'
      }))
      const runtimeCall = vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: 'test', message: 'record request only' } })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })
      const environmentId = hostId === 'local' ? null : 'recorded'
      expect(
        activateAndRevealWorktree(worktree.id, {
          executionHostId: hostId,
          runtimeEnvironmentId: environmentId,
          providesInitialSurface: true
        })
      ).not.toBe(false)
      expect(setActiveWorktree).toHaveBeenCalledWith(worktree.id, hostId, {
        stateTransition: expect.any(Function)
      })
      const transition = setActiveWorktree.mock.calls[0]?.[2]?.stateTransition
      expect(transition?.(useAppStore.getState())).toMatchObject({ activate: true })
      if (environmentId) {
        await vi.waitFor(() =>
          expect(runtimeCall).toHaveBeenCalledWith(
            expect.objectContaining({
              selector: environmentId,
              method: 'worktree.activate'
            })
          )
        )
      } else {
        expect(runtimeCall).not.toHaveBeenCalled()
      }
      expect(
        runtimeCall.mock.calls.some(([request]) => request.method === 'session.tabs.createTerminal')
      ).toBe(false)
      expect(createTab).not.toHaveBeenCalled()
    }
  )

  it.each(['local', 'ssh:box', 'inherited-ssh'] as const)(
    'real historical folder action selects exact %s pane through the store without a replacement shell',
    (kind) => {
      const before = useAppStore.getState()
      const hostId = kind === 'local' ? 'local' : 'ssh:box'
      const folder = makeFolderWorkspace({
        id: 'historical-folder',
        projectGroupId: 'historical-group',
        ...(kind === 'inherited-ssh' ? {} : { executionHostId: hostId })
      })
      const workspaceId = folderWorkspaceKey(folder.id)
      const worktree = makeCreatedAgentWorktree()
      seedEmptyActivatableWorktree(worktree)
      const tabId = 'historical-folder-tab'
      const leafId = '11111111-1111-4111-8111-111111111111'
      const ptyId = 'historical-folder-pty'
      const createTab = vi.fn()
      const run = makeRun({
        workspaceId,
        terminalPaneKey: makePaneKey(tabId, leafId),
        terminalPtyId: ptyId
      })
      useAppStore.setState({
        setActiveWorktree: originalSetActiveWorktree,
        folderWorkspaces: [folder],
        projectGroups: [{ ...makeProjectGroup(), id: 'historical-group', executionHostId: hostId }],
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'local',
        createTab,
        everActivatedWorktreeIds: new Set([workspaceId]),
        unifiedTabsByWorktree: {
          [workspaceId]: [
            {
              id: tabId,
              entityId: tabId,
              groupId: 'historical-group',
              worktreeId: workspaceId,
              contentType: 'terminal',
              executionHostId: hostId,
              label: 'Saved agent',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        tabsByWorktree: {
          [workspaceId]: [
            {
              id: tabId,
              worktreeId: workspaceId,
              ptyId,
              title: 'Saved agent',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { [tabId]: [ptyId] },
        terminalLayoutsByTabId: {
          [tabId]: {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: ptyId }
          }
        }
      })
      try {
        const runTargetFor = () =>
          resolveAutomationRunTarget(useAppStore.getState(), run, { kind: 'desktop' })
        expect(runTargetFor().worktree?.hostId).toBe(hostId)
        expect(runTargetFor().terminalTarget?.tabId).toBe(tabId)
        // SAFETY: this action uses only the list's historical target function.
        const open = createAutomationRunWorkspaceAction({
          list: { runTargetFor }
        })
        open(run)
        const after = useAppStore.getState()
        expect(after.activeWorktreeId).toBe(workspaceId)
        expect(after.activeWorkspaceExecutionHostId).toBe(hostId)
        expect(after.activeTabId).toBe(tabId)
        expect(after.terminalLayoutsByTabId[tabId].activeLeafId).toBe(leafId)
        expect(after.ptyIdsByTabId[tabId]).toEqual([ptyId])
        expect(createTab).not.toHaveBeenCalled()
      } finally {
        useAppStore.setState(before, true)
      }
    }
  )

  it('real historical workspace-only inherited folder enters through the fresh native folder path', () => {
    const before = useAppStore.getState()
    const folder = makeFolderWorkspace({
      id: 'fresh-history-folder',
      projectGroupId: 'fresh-history-group'
    })
    const workspaceId = folderWorkspaceKey(folder.id)
    seedEmptyActivatableWorktree(makeCreatedAgentWorktree())
    const run = makeRun({ workspaceId, terminalPaneKey: null, terminalPtyId: null })
    useAppStore.setState({
      folderWorkspaces: [folder],
      projectGroups: [
        { ...makeProjectGroup(), id: folder.projectGroupId, executionHostId: 'ssh:box' }
      ],
      unifiedTabsByWorktree: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      everActivatedWorktreeIds: new Set()
    })
    try {
      const runTargetFor = () =>
        resolveAutomationRunTarget(useAppStore.getState(), run, { kind: 'desktop' })
      expect(runTargetFor().viewState.canOpen).toBe(true)
      // SAFETY: only the historical resolver is consumed by this action.
      createAutomationRunWorkspaceAction({ list: { runTargetFor } })(run)
      expect(useAppStore.getState().activeWorktreeId).toBe(workspaceId)
      expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('ssh:box')
    } finally {
      useAppStore.setState(before, true)
    }
  })

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
    stubRuntimeEnvironmentBridge({ call: callRuntimeEnvironment })
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
    stubRuntimeEnvironmentBridge({ call: callRuntimeEnvironment })
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
    stubRuntimeEnvironmentBridge({ call: callRuntimeEnvironment })
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

    rememberEmptyHostAnswerForTests('web-runtime-1', folderWorkspaceKey('folder-1'))
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
    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: `bash -lc 'eval "\${${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}:?missing}"'`,
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: expect.stringContaining(
          'bash /tmp/repo/.git/orca/setup-runner.sh'
        )
      }
    })
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
