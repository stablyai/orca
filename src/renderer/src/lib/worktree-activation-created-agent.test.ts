import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import {
  activateAndRevealWorktree,
  ensureWebRuntimeWorktreeTerminalAfterWake
} from './worktree-activation'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/web-runtime-wake-terminal-respawn'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedAlreadyActiveWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'

const initialAppStoreState = useAppStore.getState()

function makeWebRuntimeWorktree() {
  return {
    ...makeWorktree(),
    hostId: 'local' as const,
    runtimeOwnerEnvironmentId: 'web-runtime-1'
  }
}

/** Activates and asserts a focusable tab appeared with no queued startup, returning its id. */
function activateAndExpectNoRelaunch(
  worktreeId: string,
  opts?: Parameters<typeof activateAndRevealWorktree>[1]
): string {
  const result = activateAndRevealWorktree(worktreeId, opts)
  const tabId = result === false ? undefined : (result.primaryTabId ?? undefined)

  expect(tabId).toBeDefined()
  expect(useAppStore.getState().pendingStartupByTabId[tabId!]).toBeUndefined()
  return tabId!
}

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  useAppStore.setState(initialAppStoreState, true)
})

describe('activateAndRevealWorktree', () => {
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

  it('does not relaunch the creation-time agent when reopening an empty worktree', () => {
    const worktree = makeWorktree()
    const { revealWorktreeInSidebar } = seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    // A focusable surface still appears — it is just a plain shell, with no queued agent launch.
    expect(result).toEqual({ primaryTabId: reopenedTab?.id })
    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })

  it('does not relaunch on repeated activate/close cycles', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      activateAndExpectNoRelaunch(worktree.id)

      // Return to zero tabs, the state that used to re-arm the relaunch. Sets state
      // directly rather than via closeTab — the sleeping-record purge is covered in
      // worktree-reactivation-tab-forkbomb.test.ts.
      useAppStore.setState({ tabsByWorktree: {}, activeTabIdByWorktree: {} })
    }
  })

  it('does not relaunch when activating a sibling worktree the user never opened', () => {
    const sibling = makeWorktree()
    const target = { ...makeWorktree(), id: 'wt-handoff', displayName: 'handoff' }
    seedEmptyActivatableWorktree(target, { extraWorktrees: [sibling] })

    // The shape post-delete focus handoff produces. That caller passes no opts at all —
    // asserted directly in active-worktree-focus-after-delete.test.ts.
    activateAndExpectNoRelaunch(target.id)
  })

  it('does not relaunch when activation opts carry no startup payload', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    // The opts shape CLI/relay navigation and notification clicks arrive with; those
    // callers are asserted in useIpcEvents.test.ts. The host's `didSpawnStartup` leg is
    // a main-process concern and is not reachable from here.
    activateAndExpectNoRelaunch(worktree.id, { notifyHostRuntime: false })
  })

  it('still queues an explicit startup supplied by the caller', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id, {
      startup: { command: 'codex' }
    })
    const state = useAppStore.getState()
    const tabId = result === false ? undefined : (result.primaryTabId ?? undefined)

    expect(tabId).toBeDefined()
    expect(state.pendingStartupByTabId[tabId!]).toEqual(
      expect.objectContaining({ command: 'codex' })
    )
  })

  it('does not duplicate a sleeping agent session owned by a preserved slept pane', () => {
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
      tabsByWorktree: {
        [worktree.id]: [
          {
            id: 'slept-tab',
            ptyId: 'wake-hint',
            worktreeId: worktree.id,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: {},
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
      sleepingAgentSessionsByPaneKey: {
        'slept-tab:0': {
          paneKey: 'slept-tab:0',
          tabId: 'slept-tab',
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'resume prior task',
          state: 'working',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      },
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
    const resumedTab = state.tabsByWorktree[worktree.id]?.find((tab) => tab.id !== 'slept-tab')

    expect(result).toEqual({ primaryTabId: null })
    expect(resumedTab).toBeUndefined()
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.sleepingAgentSessionsByPaneKey['slept-tab:0']).toMatchObject({
      paneKey: 'slept-tab:0',
      providerSession: { key: 'session_id', id: 'codex-session-1' }
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
    const worktree = makeWebRuntimeWorktree()
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
      params: {
        worktree: `id:${worktree.id}`,
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
  })

  it('activates the explicit owner runtime when another runtime is focused', async () => {
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
          addedAt: 0,
          executionHostId: 'runtime:owner-runtime'
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
        activeRuntimeEnvironmentId: 'focused-runtime',
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
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'owner-runtime',
        method: 'worktree.activate'
      })
    )
    expect(callRuntimeEnvironment).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'focused-runtime',
        method: 'worktree.activate'
      })
    )
  })

  it('does not echo host-originated runtime activation events back to the host', async () => {
    const worktree = makeWebRuntimeWorktree()
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
        ...getDefaultSettings('/workspace/.orca-workspaces'),
        agentCmdOverrides: {},
        activeRuntimeEnvironmentId: 'web-runtime-1',
        setupScriptLaunchMode: 'new-tab'
      },
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    })

    const result = activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().activeWorktreeId).toBe(worktree.id)
    expect(callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('does not respawn when the host snapshot still has terminal tabs', async () => {
    const worktree = makeWorktree()
    const callRuntimeEnvironment = vi.fn()
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true

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
      ptyIdsByTabId: { 'tab-1': [] },
      settings: {
        ...getDefaultSettings('/workspace/.orca-workspaces'),
        activeRuntimeEnvironmentId: 'web-runtime-1'
      },
      reconcileWorktreeTabModel: vi.fn(() => ({
        renderableTabCount: 1,
        activeRenderableTabId: 'tab-1'
      }))
    })

    const { shouldApplyWebSessionTabsSnapshot } = await import('@/runtime/web-session-tabs-sync')
    shouldApplyWebSessionTabsSnapshot(
      {
        worktree: worktree.id,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab-1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::leaf',
            title: 'Terminal',
            parentTabId: 'host-tab-1',
            leafId: '11111111-1111-4111-8111-111111111111',
            isActive: true,
            status: 'ready',
            terminal: 'term_host'
          }
        ]
      },
      'web-runtime-1'
    )

    ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('respawns a host terminal when waking a slept web workspace with dead local PTYs', async () => {
    const worktree = makeWebRuntimeWorktree()
    const callRuntimeEnvironment = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { repoId: worktree.repoId, worktreeId: worktree.id, activated: true }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { tabId: 'host-tab-1', terminal: 'term_host' }
      })
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: callRuntimeEnvironment,
          subscribe: vi.fn()
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
      activeWorktreeId: null,
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
      ptyIdsByTabId: { 'tab-1': [] },
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
        ...getDefaultSettings('/workspace/.orca-workspaces'),
        agentCmdOverrides: {},
        activeRuntimeEnvironmentId: 'web-runtime-1',
        setupScriptLaunchMode: 'new-tab'
      },
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar: vi.fn(),
      reconcileWorktreeTabModel: vi.fn(() => ({
        renderableTabCount: 1,
        activeRenderableTabId: 'tab-1'
      }))
    })

    ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'web-runtime-1',
        method: 'session.tabs.createTerminal'
      })
    )
  })

  it('respawns wake terminals on the explicit owner runtime when focus changed', async () => {
    const worktree = makeWorktree()
    const callRuntimeEnvironment = vi.fn().mockResolvedValue({
      ok: true,
      result: { tabId: 'host-tab-1', terminal: 'term_host' }
    })
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: callRuntimeEnvironment,
          subscribe: vi.fn()
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
          addedAt: 0,
          executionHostId: 'runtime:owner-runtime'
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
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
      ptyIdsByTabId: { 'tab-1': [] },
      settings: {
        ...getDefaultSettings('/workspace/.orca-workspaces'),
        activeRuntimeEnvironmentId: 'focused-runtime'
      },
      reconcileWorktreeTabModel: vi.fn(() => ({
        renderableTabCount: 1,
        activeRenderableTabId: 'tab-1'
      }))
    })

    ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'owner-runtime',
        method: 'session.tabs.createTerminal'
      })
    )
    expect(callRuntimeEnvironment).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'focused-runtime',
        method: 'session.tabs.createTerminal'
      })
    )
  })
})
