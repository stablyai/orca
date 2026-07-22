import { expect, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { resetRemoteRuntimeTerminalMultiplexersForTests } from '@/runtime/remote-runtime-terminal-multiplexer'

type TestMock = ReturnType<typeof vi.fn>

export const AGENT_BACKGROUND_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type AgentBackgroundSessionTestState = {
  activeRepoId: string
  activeWorktreeId: string
  lastTerminalInputAtByPaneKey: Record<string, number>
  settings: {
    agentCmdOverrides: Record<string, string>
    activeRuntimeEnvironmentId: string | null
    terminalMainSideEffectAuthority: boolean | undefined
  }
  projects: {
    id: string
    localWindowsRuntimePreference:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string | null }
  }[]
  repos: { id: string; connectionId: string | null; path: string }[]
  worktreesByRepo: Record<
    string,
    { id: string; repoId: string; projectId: string; path: string; displayName: string }[]
  >
  tabsByWorktree: Record<string, { id: string; title: string }[]>
  terminalLayoutsByTabId: Record<
    string,
    { ptyIdsByLeafId?: Record<string, string | undefined> }
  >
  ptyIdsByTabId: Record<string, string[]>
  sshConnectionStates: Map<string, { status: string }>
  transientClearedAgentStatusConnectionIds: Record<string, true>
  allWorktrees: () => { id: string; repoId: string; path: string }[]
  createTab: TestMock
  setTabCustomTitle: TestMock
  updateTabPtyId: TestMock
  closeTab: TestMock
  setTabLayout: TestMock
  clearTabPtyId: TestMock
  setAgentStatus: TestMock
  registerAgentLaunchConfig: TestMock
  clearAgentLaunchConfig: TestMock
}

export function createAgentBackgroundSessionTestState(mocks: {
  createTab: TestMock
  setTabCustomTitle: TestMock
  updateTabPtyId: TestMock
  closeTab: TestMock
  setTabLayout: TestMock
  registerAgentLaunchConfig: TestMock
}): AgentBackgroundSessionTestState {
  const state = {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    lastTerminalInputAtByPaneKey: {},
    settings: {
      agentCmdOverrides: {},
      activeRuntimeEnvironmentId: null as string | null,
      terminalMainSideEffectAuthority: undefined as boolean | undefined
    },
    projects: [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'inherit-global' as const }
      }
    ] as {
      id: string
      localWindowsRuntimePreference:
        | { kind: 'inherit-global' }
        | { kind: 'windows-host' }
        | { kind: 'wsl'; distro: string | null }
    }[],
    repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: '/repo/worktree',
          displayName: 'main'
        }
      ]
    },
    tabsByWorktree: { 'wt-1': [] as { id: string; title: string }[] },
    terminalLayoutsByTabId: {} as Record<
      string,
      { ptyIdsByLeafId?: Record<string, string | undefined> }
    >,
    ptyIdsByTabId: {} as Record<string, string[]>,
    sshConnectionStates: new Map<string, { status: string }>(),
    transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
    allWorktrees: () => state.worktreesByRepo['repo-1'],
    createTab: mocks.createTab,
    setTabCustomTitle: mocks.setTabCustomTitle,
    updateTabPtyId: mocks.updateTabPtyId,
    closeTab: mocks.closeTab,
    setTabLayout: mocks.setTabLayout,
    clearTabPtyId: vi.fn(),
    setAgentStatus: vi.fn(),
    registerAgentLaunchConfig: mocks.registerAgentLaunchConfig,
    clearAgentLaunchConfig: vi.fn()
  }
  return state
}

export function resetAgentBackgroundSessionTestState(state: AgentBackgroundSessionTestState): void {
  state.activeRepoId = 'repo-1'
  state.activeWorktreeId = 'wt-1'
  state.lastTerminalInputAtByPaneKey = {}
  state.settings = {
    agentCmdOverrides: {},
    activeRuntimeEnvironmentId: null,
    terminalMainSideEffectAuthority: undefined
  }
  state.projects = [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }]
  state.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
  state.worktreesByRepo = {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  }
  state.tabsByWorktree = { 'wt-1': [] }
  state.terminalLayoutsByTabId = {}
  state.ptyIdsByTabId = {}
  state.sshConnectionStates = new Map()
  state.transientClearedAgentStatusConnectionIds = {}
}

export function useRemoteAgentBackgroundRuntime(state: AgentBackgroundSessionTestState): void {
  state.settings = {
    agentCmdOverrides: {},
    activeRuntimeEnvironmentId: 'env-1',
    terminalMainSideEffectAuthority: undefined
  }
}

export function expectStableAgentBackgroundPaneSpawn(spawn: TestMock): string {
  const spawnArgs = spawn.mock.calls[0]?.[0]
  const paneKey = spawnArgs?.env?.ORCA_PANE_KEY
  const leafId = spawnArgs?.leafId
  expect(typeof paneKey).toBe('string')
  expect(typeof leafId).toBe('string')
  expect(leafId).toMatch(AGENT_BACKGROUND_SESSION_UUID_RE)
  expect(paneKey).toBe(`tab-1:${leafId}`)
  return paneKey
}

export function stubAgentBackgroundSessionWindow(mocks: {
  dispatchEvent: TestMock
  spawn: TestMock
  write: TestMock
  kill: TestMock
  markTrusted: TestMock
  runtimeEnvironmentCall: TestMock
  runtimeEnvironmentSubscribe: TestMock
}): void {
  vi.stubGlobal('window', {
    dispatchEvent: mocks.dispatchEvent,
    api: {
      pty: { spawn: mocks.spawn, write: mocks.write, kill: mocks.kill },
      agentTrust: { markTrusted: mocks.markTrusted },
      runtime: { call: vi.fn() },
      runtimeEnvironments: {
        call: mocks.runtimeEnvironmentCall,
        subscribe: mocks.runtimeEnvironmentSubscribe
      }
    }
  })
}

export function resetAgentBackgroundSessionTestHarness(args: {
  state: AgentBackgroundSessionTestState
  createTab: TestMock
  closeTab: TestMock
  setTabLayout: TestMock
  updateTabPtyId: TestMock
  spawn: TestMock
  write: TestMock
  kill: TestMock
  markTrusted: TestMock
  dispatchEvent: TestMock
  getLaunchPlatform: TestMock
  runtimeCall: TestMock
  runtimeTransportCall: TestMock
  runtimeSubscribe: TestMock
  subscribeToData: TestMock
  subscribeToExit: TestMock
}): void {
  resetRemoteRuntimeTerminalMultiplexersForTests()
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  args.getLaunchPlatform.mockReturnValue('linux')
  args.runtimeTransportCall.mockImplementation(
    (request) =>
      createCompatibleRuntimeStatusResponseIfNeeded(request) ??
      (args.runtimeCall as unknown as (value: unknown) => unknown)(request)
  )
  resetAgentBackgroundSessionTestState(args.state)
  args.createTab.mockImplementation(() => {
    const tab = { id: 'tab-1', title: 'Terminal 1' }
    args.state.tabsByWorktree['wt-1'].push(tab)
    return tab
  })
  args.closeTab.mockImplementation((tabId: string) => {
    args.state.tabsByWorktree['wt-1'] = args.state.tabsByWorktree['wt-1'].filter(
      (tab) => tab.id !== tabId
    )
  })
  args.setTabLayout.mockImplementation((tabId: string, layout) => {
    args.state.terminalLayoutsByTabId[tabId] = layout
  })
  args.updateTabPtyId.mockImplementation((tabId: string, ptyId: string) => {
    args.state.ptyIdsByTabId[tabId] = [ptyId]
  })
  args.spawn.mockResolvedValue({ id: 'pty-1' })
  args.runtimeCall.mockResolvedValue({
    ok: true,
    result: { terminal: { handle: 'terminal-1', worktreeId: 'wt-1', title: null } }
  })
  args.runtimeSubscribe.mockImplementation(async (_request, callbacks) => {
    queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
    return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
  })
  args.subscribeToData.mockReturnValue(vi.fn())
  args.subscribeToExit.mockReturnValue(vi.fn())
  stubAgentBackgroundSessionWindow({
    dispatchEvent: args.dispatchEvent,
    spawn: args.spawn,
    write: args.write,
    kill: args.kill,
    markTrusted: args.markTrusted,
    runtimeEnvironmentCall: args.runtimeTransportCall,
    runtimeEnvironmentSubscribe: args.runtimeSubscribe
  })
}
