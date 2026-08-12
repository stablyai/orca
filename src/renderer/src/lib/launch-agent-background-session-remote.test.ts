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
const mockMarkTrusted = vi.fn()
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

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-launch-platform', () => ({
  getAgentLaunchPlatformForRepo: mockGetAgentLaunchPlatformForRepo
}))

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
      markTrusted: mockMarkTrusted,
      spawn: mockSpawn,
      write: mockWrite
    })
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
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

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
    expect(mockRuntimeEnvironmentSubscribe).not.toHaveBeenCalled()
    expect(mockDispatchEvent).not.toHaveBeenCalled()
  })

  it('forwards Hermes startup queries through SSH command transport', async () => {
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

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

  it('injects fast startup commands into SSH background sessions after shell output arrives', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

      await launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation',
        title: 'Nightly audit'
      })

      expect(mockSpawn.mock.calls[0]?.[0]?.command).toBe(
        "claude '--dangerously-skip-permissions' 'run the automation'"
      )
      expect(mockSpawn.mock.calls[0]?.[0]?.startupCommandDelivery).toBeUndefined()
      const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
      dataSidecar('user@remote repo % ')
      vi.advanceTimersByTime(50)

      expect(mockWrite).toHaveBeenCalledWith(
        'pty-1',
        "claude '--dangerously-skip-permissions' 'run the automation'\r"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for shell-ready before injecting payload-bearing SSH background commands', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

      await launchAgentBackgroundSession({
        agent: 'codex',
        worktreeId: 'wt-1',
        prompt: 'run the automation',
        title: 'Nightly audit'
      })

      expect(mockSpawn.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'run the automation'",
          startupCommandDelivery: 'shell-ready'
        })
      )
      const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
      dataSidecar('user@remote repo % ')
      vi.advanceTimersByTime(50)
      expect(mockWrite).not.toHaveBeenCalled()

      dataSidecar('\x1b]777;orca-shell-ready\x07user@remote repo % ')
      vi.advanceTimersByTime(50)

      expect(mockWrite).toHaveBeenCalledWith(
        'pty-1',
        "codex '--dangerously-bypass-approvals-and-sandbox' 'run the automation'\r"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back when an SSH shell produces no observable startup data', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

      await launchAgentBackgroundSession({
        agent: 'codex',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
      // Why the longer wait: a shell that has emitted nothing is still booting,
      // so the fallback holds off rather than pasting before readline arms.
      vi.advanceTimersByTime(1_550)
      expect(mockWrite).not.toHaveBeenCalled()
      vi.advanceTimersByTime(15_050)

      expect(mockWrite).toHaveBeenCalledWith(
        'pty-1',
        "codex '--dangerously-bypass-approvals-and-sandbox' 'run the automation'\r"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the short fallback for an SSH shell that talks but cannot emit the marker', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

      await launchAgentBackgroundSession({
        agent: 'codex',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
      const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
      dataSidecar('user@remote repo % ')
      vi.advanceTimersByTime(1_550)

      expect(mockWrite).toHaveBeenCalledWith(
        'pty-1',
        "codex '--dangerously-bypass-approvals-and-sandbox' 'run the automation'\r"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for shell-ready for SSH background Codex native prefill commands without a hint', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      state.settings = {
        agentCmdOverrides: { codex: "codex --prefill 'draft from override'" },
        activeRuntimeEnvironmentId: null,
        terminalMainSideEffectAuthority: undefined
      }
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

      await launchAgentBackgroundSession({
        agent: 'codex',
        worktreeId: 'wt-1',
        title: 'Nightly audit'
      })

      expect(mockSpawn.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          command:
            "codex --prefill 'draft from override' '--dangerously-bypass-approvals-and-sandbox'"
        })
      )
      expect(mockSpawn.mock.calls[0]?.[0]).not.toHaveProperty('startupCommandDelivery')
      const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
      dataSidecar('user@remote repo % ')
      vi.advanceTimersByTime(50)
      expect(mockWrite).not.toHaveBeenCalled()

      dataSidecar('\x1b]777;orca-shell-ready\x07user@remote repo % ')
      vi.advanceTimersByTime(50)

      expect(mockWrite).toHaveBeenCalledWith(
        'pty-1',
        "codex --prefill 'draft from override' '--dangerously-bypass-approvals-and-sandbox'\r"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rearm SSH background startup delivery after exit cleanup', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

      await launchAgentBackgroundSession({
        agent: 'codex',
        worktreeId: 'wt-1',
        prompt: 'run the automation',
        title: 'Nightly audit'
      })

      const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
      const exitSidecar = mockSubscribeToPtyExit.mock.calls[0]?.[1] as (code: number) => void
      exitSidecar(0)

      dataSidecar('\x1b]777;orca-shell-ready\x07user@remote repo % ')
      vi.advanceTimersByTime(50)

      expect(mockWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates background sessions on the active runtime environment', async () => {
    useRemoteAgentBackgroundRuntime(state)
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    const params = mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params
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
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

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
          launchAgent: 'claude',
          presentation: 'background'
        })
      })
    )
  })

  it('closes a created runtime terminal when its data subscription fails', async () => {
    useRemoteAgentBackgroundRuntime(state)
    mockRuntimeEnvironmentSubscribe.mockRejectedValueOnce(new Error('subscription failed'))
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('subscription failed')

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
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'codex',
      worktreeId: 'folder:fw-1',
      prompt: 'run the automation'
    })

    expect(mockMarkTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/srv/proj',
      connectionId: 'ssh-1'
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
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

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
