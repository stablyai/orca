import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentBackgroundSessionTestState,
  expectReservedAgentBackgroundTabId,
  expectStableAgentBackgroundPaneSpawn,
  resetAgentBackgroundSessionTestHarness
} from '@/lib/agent-background-session-test-state'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockWrite = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentTransportCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockSetTabLayout = vi.fn()
const mockRegisterAgentLaunchConfig = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockDispatchEvent = vi.fn()
const mockGetAgentLaunchPlatformForRepo = vi.fn<() => NodeJS.Platform>()
const mockHostKind = vi.fn<() => 'local' | 'runtime'>(() => 'local')
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})
let currentStoreState = state

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => currentStoreState,
    subscribe: vi.fn(() => () => {})
  }
}))

// Why: the background mount's sleeping-agent scan reads store state these launches never seed.
vi.mock('@/lib/sleeping-agent-wake-requests', () => ({ requestSleepingAgentWakeOnMount: vi.fn() }))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/execution-host-facts', async (importOriginal) => {
  const hostFact = () => ({
    kind: 'known' as const,
    platform: mockGetAgentLaunchPlatformForRepo(),
    hostKind: mockHostKind()
  })
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRepoExecutionHostPlatform: hostFact,
    resolveWorktreeExecutionHostPlatform: hostFact
  }
})

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

describe('launchAgentBackgroundSession', () => {
  beforeEach(() => {
    currentStoreState = state
    resetAgentBackgroundSessionTestHarness({
      state,
      createTab: mockCreateTab,
      closeTab: mockCloseTab,
      getLaunchPlatform: mockGetAgentLaunchPlatformForRepo,
      runtimeCall: mockRuntimeEnvironmentCall,
      runtimeTransportCall: mockRuntimeEnvironmentTransportCall,
      runtimeSubscribe: mockRuntimeEnvironmentSubscribe,
      subscribeToData: mockSubscribeToPtyData,
      subscribeToExit: mockSubscribeToPtyExit,
      setTabLayout: mockSetTabLayout,
      updateTabPtyId: mockUpdateTabPtyId,
      dispatchEvent: mockDispatchEvent,
      kill: mockKill,
      spawn: mockSpawn,
      write: mockWrite
    })
  })

  it('does not create or mount the tab while the explicit PTY spawn is unresolved', async () => {
    let resolveSpawn!: (result: { id: string }) => void
    mockSpawn.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        resolveSpawn = resolve
      })
    )
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    const launch = launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run slowly'
    })
    await Promise.resolve()

    // Publishing a PTY-less tab here reproduces #2989.
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockDispatchEvent).not.toHaveBeenCalled()

    resolveSpawn({ id: 'pty-slow' })
    await expect(launch).resolves.toMatchObject({ ptyId: 'pty-slow' })
    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    expect(mockCreateTab.mock.calls[0]?.[3]).toMatchObject({
      id: tabId,
      initialPtyId: 'pty-slow'
    })
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith(tabId, 'pty-slow')
    expect(mockDispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { worktreeId: 'wt-1', tabIds: [tabId] } })
    )
  })

  it('adopts effective host facts and fences status to that launch and live binding', async () => {
    const launchConfig = {
      agentCommand: '/host/cx',
      agentArgs: '--host-only',
      agentEnv: { HOST: 'yes' }
    }
    mockSpawn.mockResolvedValueOnce({
      id: 'host-pty',
      launchConfig,
      launchAgent: 'codex',
      launchToken: 'host-token',
      incarnationId: 'host-incarnation'
    })
    state.settings.terminalMainSideEffectAuthority = false
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      sessionOptions: {}
    })
    expect(result).not.toBeNull()
    const spawn = mockSpawn.mock.calls[0][0]
    expect(spawn.launchToken).not.toBe('host-token')
    expect(mockRegisterAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(
      result?.paneKey,
      launchConfig,
      expect.objectContaining({
        agentType: 'codex',
        launchToken: 'host-token',
        tabId: spawn.tabId,
        leafId: spawn.leafId
      })
    )
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledWith(
      'host-pty',
      expect.any(Function),
      'host-incarnation'
    )
    const consume = mockSubscribeToPtyData.mock.calls[0][1]
    const done = '\x1b]9999;{"state":"done","prompt":"ok","agentType":"codex"}\x07'
    consume(done)
    expect(state.setAgentStatus).toHaveBeenCalledWith(
      result?.paneKey,
      expect.objectContaining({ state: 'done', agentType: 'codex' }),
      undefined,
      undefined,
      { connectionId: null },
      { launchToken: 'host-token' }
    )
    state.setAgentStatus.mockClear()
    state.ptyIdsByTabId[spawn.tabId] = ['replacement']
    consume(done)
    expect(state.setAgentStatus).not.toHaveBeenCalled()
  })

  it('delivers stdin-after-start text once after adoption, outside the command request', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    const result = await launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: '  first line\nsecond line  ',
      agentArgs: null,
      extraAgentArgs: '--verbose',
      sessionOptions: { model: 'opaque/model' }
    })
    expect(mockSpawn.mock.calls[0][0].agentLaunch).toEqual({
      launch: {
        agent: 'aider',
        target: { kind: 'existing', worktree: 'id:wt-1' },
        agentArgs: null,
        sessionOptions: { model: 'opaque/model' }
      },
      extraAgentArgs: '--verbose',
      startupPromptCarry: 'force-line',
      suppressStartupUpdatePrompt: true,
      returnLaunchFailure: true
    })
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        tabId: result?.tabId,
        content: 'first line\nsecond line',
        agent: 'aider',
        submit: true
      })
    )
    expect(mockCreateTab.mock.invocationCallOrder[0]).toBeLessThan(
      mockPasteDraftWhenAgentReady.mock.invocationCallOrder[0]
    )
  })

  it('kills a local PTY when its worktree disappears before spawn resolves', async () => {
    let resolveSpawn!: (result: { id: string }) => void
    mockSpawn.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        resolveSpawn = resolve
      })
    )
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    const launch = launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run slowly'
    })
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce())
    state.worktreesByRepo['repo-1'] = []
    resolveSpawn({ id: 'pty-after-close' })

    await expect(launch).resolves.toBeNull()
    expect(mockKill).toHaveBeenCalledWith('pty-after-close')
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
    expect(mockSubscribeToPtyData).not.toHaveBeenCalled()
    expect(mockDispatchEvent).not.toHaveBeenCalled()
  })

  it('leaves no tab behind if PTY spawn fails', async () => {
    mockSpawn.mockRejectedValueOnce(new Error('spawn failed'))
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('spawn failed')

    // Why: the tab is only created once a PTY is live, so a failed spawn has nothing to close.
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${expectReservedAgentBackgroundTabId(mockSpawn)}:`))
    )
    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
  })

  it('closes the adopted tab if binding fails after the PTY is live', async () => {
    mockSubscribeToPtyData.mockImplementationOnce(() => {
      throw new Error('subscribe failed')
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('subscribe failed')

    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    expect(mockCloseTab).toHaveBeenCalledWith(tabId, {
      recordInteraction: false,
      reason: 'cleanup'
    })
    expect(mockKill).toHaveBeenCalledWith('pty-1')
  })

  it('retires the launch instead of adopting a colliding tab id', async () => {
    mockSpawn.mockImplementationOnce((args: { tabId: string }) => {
      currentStoreState = {
        ...state,
        tabsByWorktree: {
          ...state.tabsByWorktree,
          'wt-1': [{ id: args.tabId, title: 'Squatter' }]
        }
      }
      return Promise.resolve({ id: 'pty-1' })
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).resolves.toBeNull()

    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockKill).toHaveBeenCalledWith('pty-1')
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(
      expectStableAgentBackgroundPaneSpawn(mockSpawn)
    )
  })
})
