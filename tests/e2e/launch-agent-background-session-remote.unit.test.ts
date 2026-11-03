import { projectAgentLaunchSettings } from '../../src/shared/agent-launch-settings'
import './prepared-action-launch.test-fixture'
import '../../src/renderer/src/lib/runtime-agent-background-create'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import '../../src/shared/agent-session/agent-session-runtime-capabilities'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_BACKGROUND_SESSION_UUID_RE as UUID_RE,
  createAgentBackgroundSessionTestState,
  resetAgentBackgroundSessionTestHarness,
  useRemoteAgentBackgroundRuntime
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
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
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
    hostKind: 'local' as const
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

describe('launchAgentBackgroundSession remote runtime and SSH startup delivery', () => {
  beforeEach(() => {
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

  it('prepares capability and settles one host-owned background launch without client compilation', async () => {
    vi.useFakeTimers()
    try {
      useRemoteAgentBackgroundRuntime(state)
      Object.assign(state.settings, {
        agentLaunchChoices: { claude: { options: { effort: 'low' } } },
        agentDefaultArgs: { claude: '--verbose' },
        agentDefaultEnv: { claude: { KEEP: 'caller' } }
      })
      const status = Promise.withResolvers<unknown>()
      mockRuntimeEnvironmentTransportCall.mockImplementation((request) =>
        request.method === 'status.get' ? status.promise : mockRuntimeEnvironmentCall(request)
      )
      const settings = Promise.withResolvers<void>()
      mockRuntimeEnvironmentSubscribe.mockImplementation(async (request, callbacks) => {
        const answer = () =>
          callbacks.onResponse({
            ok: true,
            result:
              request.method === 'settings.getAgentLaunch'
                ? {
                    settings: projectAgentLaunchSettings({
                      agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
                    })
                  }
                : { type: 'ready' }
          })
        if (request.method === 'settings.getAgentLaunch') {
          void settings.promise.then(answer)
        } else {
          queueMicrotask(answer)
        }
        return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
      })
      const { launchAgentBackgroundSession } =
        await import('../../src/renderer/src/lib/launch-agent-background-session')
      const attempt = launchAgentBackgroundSession({ agent: 'claude', worktreeId: 'wt-1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(mockRegisterAgentLaunchConfig).not.toHaveBeenCalled()
      const request = mockRuntimeEnvironmentTransportCall.mock.calls[0][0]
      status.resolve(createCompatibleRuntimeStatusResponseIfNeeded(request))
      await vi.advanceTimersByTimeAsync(3_000)
      const result = await attempt
      expect(
        mockRuntimeEnvironmentSubscribe.mock.calls.some(
          ([request]) => request.method === 'settings.getAgentLaunch'
        )
      ).toBe(false)
      expect(
        mockRuntimeEnvironmentCall.mock.calls.find(
          ([request]) => request.method === 'terminal.createAgentSession'
        )?.[0].params
      ).not.toHaveProperty('sessionOptions')
      expect(
        mockRuntimeEnvironmentCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toHaveLength(1)
      expect(
        mockRuntimeEnvironmentCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.create'
        )
      ).toHaveLength(0)
      expect(
        mockRuntimeEnvironmentTransportCall.mock.calls.filter(
          ([request]) => request.method === 'status.get'
        )
      ).toHaveLength(1)
      expect(result?.ptyId).toBe('remote:env-1@@terminal-1')
      expect(mockCreateTab).toHaveBeenCalledTimes(1)
      settings.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockCreateTab).toHaveBeenCalledTimes(1)
      result?.releaseRuntimeObservers?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts the paired host token and configuration without client prediction', async () => {
    useRemoteAgentBackgroundRuntime(state)
    const launchConfig = {
      agentCommand: '/server/cx',
      agentArgs: '--server',
      agentEnv: { SERVER: 'yes' }
    }
    mockRuntimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-host',
          worktreeId: 'wt-1',
          title: null,
          launchConfig,
          launchAgent: 'codex',
          launchToken: 'server-token'
        }
      }
    })
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')
    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      sessionOptions: {},
      extraAgentArgs: '--add-dir docs'
    })
    const request = mockRuntimeEnvironmentCall.mock.calls[0][0].params
    expect(request).toMatchObject({ sessionOptions: {}, extraAgentArgs: '--add-dir docs' })
    expect(request).not.toHaveProperty('agentArgs')
    expect(mockRegisterAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(
      result?.paneKey,
      launchConfig,
      expect.objectContaining({
        agentType: 'codex',
        launchToken: 'server-token',
        tabId: request.placement.tabId,
        leafId: request.placement.leafId
      })
    )
    expect(mockSpawn).not.toHaveBeenCalled()
    result?.releaseRuntimeObservers()
  })

  it('closes a runtime terminal when its worktree disappears before creation resolves', async () => {
    useRemoteAgentBackgroundRuntime(state)
    let resolveCreate!: (result: {
      ok: true
      result: { terminal: { handle: string; worktreeId: string; title: null } }
    }) => void
    const createResult = new Promise<{
      ok: true
      result: { terminal: { handle: string; worktreeId: string; title: null } }
    }>((resolve) => {
      resolveCreate = resolve
    })
    mockRuntimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.createAgentSession') {
        return createResult
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    const launch = launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run remotely'
    })
    await vi.waitFor(() =>
      expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.createAgentSession' })
      )
    )
    state.worktreesByRepo['repo-1'] = []
    resolveCreate({
      ok: true,
      result: { terminal: { handle: 'terminal-after-close', worktreeId: 'wt-1', title: null } }
    })

    await expect(launch).resolves.toBeNull()
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close',
        params: { terminal: 'terminal-after-close' }
      })
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
    expect(
      mockRuntimeEnvironmentSubscribe.mock.calls.filter(
        ([request]) => request.method !== 'settings.getAgentLaunch'
      )
    ).toHaveLength(0)
    expect(mockDispatchEvent).not.toHaveBeenCalled()
  })

  it('aborts the remote exit wait and closes the stream when run observers are released', async () => {
    useRemoteAgentBackgroundRuntime(state)
    const streamSend = vi.fn()
    const waitUnsubscribe = vi.fn()
    mockRuntimeEnvironmentSubscribe.mockImplementation(async (request, callbacks) => {
      if (request.method === 'terminal.multiplex') {
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe: vi.fn(), sendBinary: streamSend }
      }
      if (request.method === 'terminal.wait') {
        return { unsubscribe: waitUnsubscribe, sendBinary: vi.fn() }
      }
      throw new Error(`Unexpected runtime subscription: ${request.method}`)
    })
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })
    await vi.waitFor(() =>
      expect(mockRuntimeEnvironmentSubscribe).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.wait' }),
        expect.any(Object)
      )
    )
    const sendsBeforeRelease = streamSend.mock.calls.length

    result?.releaseRuntimeObservers()
    result?.releaseRuntimeObservers()

    await vi.waitFor(() => expect(waitUnsubscribe).toHaveBeenCalledOnce())
    // One unsubscribe frame for the terminal's data stream.
    expect(streamSend.mock.calls.length).toBe(sendsBeforeRelease + 1)
  })

  it('closes a created runtime terminal when its data subscription fails', async () => {
    useRemoteAgentBackgroundRuntime(state)
    const subscribe = mockRuntimeEnvironmentSubscribe.getMockImplementation()
    mockRuntimeEnvironmentSubscribe.mockImplementation((request, callbacks) => {
      if (request.method === 'terminal.multiplex') {
        return Promise.reject(new Error('subscription failed'))
      }
      return subscribe?.(request, callbacks)
    })
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('subscription failed')

    expect(
      mockRuntimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'terminal.createAgentSession'
      )
    ).toHaveLength(1)
    expect(
      mockRuntimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'terminal.create'
      )
    ).toHaveLength(0)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.close',
      params: { terminal: 'terminal-1' },
      timeoutMs: undefined
    })
    const tabId = mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params?.placement?.tabId
    expect(tabId).toMatch(UUID_RE)
    expect(state.clearTabPtyId).toHaveBeenCalledWith(tabId, 'remote:env-1@@terminal-1')
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${tabId}:`))
    )
    expect(mockCloseTab).toHaveBeenCalledWith(tabId, {
      recordInteraction: false,
      reason: 'cleanup'
    })
    expect(mockDispatchEvent).not.toHaveBeenCalled()
  })
})
