import { projectAgentLaunchSettings } from '../../src/shared/agent-launch-settings'
import {
  independentActionEffortPlan,
  consumePreparedBackgroundCommand
} from './prepared-action-launch.test-fixture'
import { createRuntimeAgentBackgroundTerminal } from '../../src/renderer/src/lib/runtime-agent-background-create'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
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

  it('prepares capability before compiling a cold desktop effort fallback and settles one background launch', async () => {
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
      expect(result?.startupPlan.launchCommand).toContain("'--verbose'")
      expect(result?.startupPlan.launchCommand).not.toContain("'low'")
      expect(result?.startupPlan.sessionOptions?.effort).toBeUndefined()
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

  it.each(['claude', 'codex'] as const)(
    'delivers independent %s effort through the real prepared background callback',
    async (agent) => {
      useRemoteAgentBackgroundRuntime(state)
      const plan = independentActionEffortPlan(agent)
      const spawn = vi.fn<Parameters<typeof consumePreparedBackgroundCommand>[1]>(async () => ({
        handle: 'prepared-background',
        worktreeId: 'wt-1',
        title: null,
        savedStartupCwd: 'private'
      }))
      mockRuntimeEnvironmentCall.mockImplementation(async (request) => {
        if (request.method !== 'terminal.create') {
          throw new Error(`Unexpected create route ${request.method}`)
        }
        return { ok: true, result: await consumePreparedBackgroundCommand(request.params, spawn) }
      })
      await expect(
        createRuntimeAgentBackgroundTerminal({
          environmentId: 'env-1',
          worktreeId: 'wt-1',
          tabId: 'reserved-tab',
          leafId: 'reserved-leaf',
          agent,
          prompt: 'Fix checks',
          sessionOptions: plan.sessionOptions,
          legacy: {
            command: plan.launchCommand,
            env: plan.env ?? {},
            launchConfig: plan.launchConfig,
            startupCommandDelivery: plan.startupCommandDelivery,
            launchToken: 'reserved-token'
          }
        })
      ).resolves.toEqual({
        terminal: { handle: 'prepared-background', worktreeId: 'wt-1', title: null }
      })
      expect(spawn).toHaveBeenCalledExactlyOnceWith('id:wt-1', {
        // A paired client's terminal.create is the user's act (E9).
        wslUserAct: true,
        command: plan.launchCommand,
        env: { ACTION_PROFILE: 'captured' },
        envToDelete: undefined,
        launchConfig: plan.launchConfig,
        launchAgent: agent,
        startupCommandDelivery: agent === 'codex' ? 'shell-ready' : undefined,
        terminalImageViewerSupported: false,
        terminalKittyKeyboardProtocol: true,
        title: undefined,
        focus: false,
        activate: false,
        presentation: 'background',
        tabId: 'reserved-tab',
        leafId: 'reserved-leaf',
        launchToken: 'reserved-token',
        preAllocatedHandle: 'reserved-handle'
      })
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(mockRuntimeEnvironmentCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method: 'terminal.create',
          params: expect.objectContaining({
            tabId: 'reserved-tab',
            leafId: 'reserved-leaf',
            launchToken: 'reserved-token',
            presentation: 'background'
          })
        })
      )
    }
  )

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

  it('forwards Hermes startup queries through SSH command transport', async () => {
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'hermes',
      worktreeId: 'wt-1',
      prompt: 'remote automation prompt'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('ORCA_HERMES_STARTUP_QUERY'),
        connectionId: 'ssh-1',
        env: expect.objectContaining({ ORCA_HERMES_STARTUP_QUERY: 'remote automation prompt' })
      })
    )
  })

  it.each(['claude', 'codex'] as const)(
    'has the relay type the %s launch line instead of writing it from the renderer',
    async (agent) => {
      vi.useFakeTimers()
      try {
        state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
        const { launchAgentBackgroundSession } =
          await import('../../src/renderer/src/lib/launch-agent-background-session')

        await launchAgentBackgroundSession({
          agent,
          worktreeId: 'wt-1',
          prompt: 'run the automation'
        })

        expect(mockSpawn.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            command: expect.stringContaining("'run the automation'"),
            connectionId: 'ssh-1',
            commandDelivery: 'provider',
            startupCommandDelivery: 'shell-ready'
          })
        )
        const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
        dataSidecar('\x1b]777;orca-shell-ready\x07user@remote repo % ')
        vi.advanceTimersByTime(20_000)
        expect(mockWrite).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('has the relay type a promptless SSH background launch too', async () => {
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    await launchAgentBackgroundSession({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockSpawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        commandDelivery: 'provider',
        startupCommandDelivery: 'shell-ready'
      })
    )
  })

  it.each([true, false])(
    'creates background sessions with negotiated keyboard support: %s',
    async (keyboardSupported) => {
      useRemoteAgentBackgroundRuntime(state)
      mockRuntimeEnvironmentTransportCall.mockImplementation((request: { method: string }) => {
        const status = createCompatibleRuntimeStatusResponseIfNeeded(request)
        if (status?.ok) {
          return Promise.resolve({
            ...status,
            result: {
              ...status.result,
              capabilities: status.result.capabilities?.filter(
                (capability) =>
                  keyboardSupported || capability !== AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY
              )
            }
          })
        }
        return mockRuntimeEnvironmentCall(request)
      })
      const { launchAgentBackgroundSession } =
        await import('../../src/renderer/src/lib/launch-agent-background-session')

      const result = await launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })

      expect(mockSpawn).not.toHaveBeenCalled()
      const params = mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params
      if (keyboardSupported) {
        expect(params).toHaveProperty('terminalKittyKeyboardProtocol', true)
      } else {
        expect(params).not.toHaveProperty('terminalKittyKeyboardProtocol')
      }
      const leafId = params?.placement?.leafId
      const tabId = params?.placement?.tabId
      expect(leafId).toMatch(UUID_RE)
      expect(tabId).toMatch(UUID_RE)
      // Why: background launches have no explicit recipe override, so remote host settings win.
      expect(params).not.toHaveProperty('agentArgs')
      expect(mockRegisterAgentLaunchConfig).toHaveBeenCalledWith(
        `${tabId}:${leafId}`,
        {
          agentCommand: "claude '--dangerously-skip-permissions'",
          agentArgs: '--dangerously-skip-permissions',
          agentEnv: {}
        },
        {
          agentType: 'claude',
          launchToken: expect.stringMatching(UUID_RE),
          tabId,
          leafId
        }
      )
      expect(mockSetTabLayout).toHaveBeenCalledWith(
        tabId,
        expect.objectContaining({
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          ptyIdsByLeafId: { [leafId]: 'remote:env-1@@terminal-1' }
        })
      )
      expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.createAgentSession',
        params: expect.objectContaining({
          clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
          worktree: 'id:wt-1',
          agent: 'claude',
          prompt: 'run the automation',
          promptDelivery: 'auto-submit',
          placement: { tabId, leafId },
          presentation: 'background'
        }),
        timeoutMs: 15_000
      })
      expect(mockUpdateTabPtyId).toHaveBeenCalledWith(tabId, 'remote:env-1@@terminal-1')
      expect(mockRegisterEagerPtyBuffer).not.toHaveBeenCalled()
      expect(mockRuntimeEnvironmentSubscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-1',
          method: 'terminal.multiplex',
          params: {}
        }),
        expect.any(Object)
      )
      expect(result).toMatchObject({
        tabId,
        paneKey: `${tabId}:${leafId}`,
        ptyId: 'remote:env-1@@terminal-1',
        terminalOwnership: null
      })
    }
  )

  it('advertises keyboard support for a background OMP launch', async () => {
    useRemoteAgentBackgroundRuntime(state)
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')
    await launchAgentBackgroundSession({ agent: 'omp', worktreeId: 'wt-1', prompt: 'review' })
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.createAgentSession',
        params: expect.objectContaining({
          agent: 'omp',
          terminalKittyKeyboardProtocol: true,
          presentation: 'background'
        })
      })
    )
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

  it('preserves the legacy background spawn on an old remote host', async () => {
    useRemoteAgentBackgroundRuntime(state)
    mockRuntimeEnvironmentTransportCall.mockImplementation((request: { method: string }) => {
      if (request.method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: []
          }
        })
      }
      return Promise.resolve({
        id: 'create',
        ok: true,
        result: { terminal: { handle: 'legacy-terminal-1' } }
      })
    })
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run remotely'
      })
    ).resolves.toMatchObject({ ptyId: 'remote:env-1@@legacy-terminal-1' })

    expect(mockRuntimeEnvironmentTransportCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({
          worktree: 'id:wt-1',
          command: "claude '--dangerously-skip-permissions' 'run remotely'",
          terminalKittyKeyboardProtocol: true,
          launchAgent: 'claude',
          presentation: 'background'
        })
      })
    )
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

  it('spawns an SSH folder-workspace automation on the owning host, not locally', async () => {
    // Folder workspaces have no repo row, so launch ownership comes from their scope.
    state.repos = [
      { id: 'repo-1', connectionId: 'ssh-1', path: '/srv/proj/api', projectGroupId: 'grp-1' }
    ]
    state.projectGroups = [{ id: 'grp-1', parentGroupId: null, connectionId: 'ssh-1' }]
    state.folderWorkspaces = [
      { id: 'fw-1', projectGroupId: 'grp-1', folderPath: '/srv/proj', connectionId: 'ssh-1' }
    ]
    state.getKnownWorktreeById = (worktreeId: string) =>
      worktreeId === 'folder:fw-1' ? { id: 'folder:fw-1', path: '/srv/proj' } : undefined
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'codex',
      worktreeId: 'folder:fw-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', cwd: '/srv/proj' })
    )
  })

  it('keeps a local folder workspace on the local host', async () => {
    state.repos = [
      { id: 'repo-1', connectionId: null, path: '/home/me/proj/api', projectGroupId: 'grp-1' }
    ]
    state.projectGroups = [{ id: 'grp-1', parentGroupId: null, connectionId: null }]
    state.folderWorkspaces = [
      { id: 'fw-1', projectGroupId: 'grp-1', folderPath: '/home/me/proj', connectionId: null }
    ]
    state.getKnownWorktreeById = (worktreeId: string) =>
      worktreeId === 'folder:fw-1' ? { id: 'folder:fw-1', path: '/home/me/proj' } : undefined
    const { launchAgentBackgroundSession } =
      await import('../../src/renderer/src/lib/launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'folder:fw-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: null, cwd: '/home/me/proj' })
    )
  })
})
