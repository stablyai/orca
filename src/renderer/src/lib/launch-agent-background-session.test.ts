/* eslint-disable max-lines -- Why: local/runtime launch tests share a mock harness. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const mockSpawn = vi.fn()
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function expectStablePaneSpawn(): string {
  const spawnArgs = mockSpawn.mock.calls[0]?.[0]
  const paneKey = spawnArgs?.env?.ORCA_PANE_KEY
  const leafId = spawnArgs?.leafId
  expect(typeof paneKey).toBe('string')
  expect(typeof leafId).toBe('string')
  expect(leafId).toMatch(UUID_RE)
  expect(paneKey).toBe(`tab-1:${leafId}`)
  return paneKey
}

const state = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: { agentCmdOverrides: {}, activeRuntimeEnvironmentId: null as string | null },
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
  allWorktrees: vi.fn(() => state.worktreesByRepo['repo-1']),
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  clearTabPtyId: vi.fn(),
  setAgentStatus: vi.fn(),
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig,
  clearAgentLaunchConfig: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state
  }
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

describe('launchAgentBackgroundSession', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    mockRuntimeEnvironmentTransportCall.mockImplementation(
      (args) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? mockRuntimeEnvironmentCall(args)
    )
    state.activeRepoId = 'repo-1'
    state.activeWorktreeId = 'wt-1'
    state.settings = { agentCmdOverrides: {}, activeRuntimeEnvironmentId: null }
    state.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ]
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
    mockCreateTab.mockReturnValue({ id: 'tab-1', title: 'Terminal 1' })
    mockSpawn.mockResolvedValue({ id: 'pty-1' })
    mockRuntimeEnvironmentCall.mockResolvedValue({
      ok: true,
      result: { terminal: { handle: 'terminal-1', worktreeId: 'wt-1', title: null } }
    })
    mockRuntimeEnvironmentSubscribe.mockImplementation(async (_args, callbacks) => {
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    mockSubscribeToPtyData.mockReturnValue(vi.fn())
    mockSubscribeToPtyExit.mockReturnValue(vi.fn())
    vi.stubGlobal('window', {
      api: {
        pty: {
          spawn: mockSpawn,
          write: mockWrite
        },
        agentTrust: {
          markTrusted: mockMarkTrusted
        },
        runtime: {
          call: vi.fn()
        },
        runtimeEnvironments: {
          call: mockRuntimeEnvironmentTransportCall,
          subscribe: mockRuntimeEnvironmentSubscribe
        }
      }
    })
  })

  it('spawns a PTY immediately and adopts it in an inactive tab', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      title: 'Nightly audit'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/worktree',
        command: "claude '--dangerously-skip-permissions' 'run the automation'",
        env: expect.objectContaining({
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1'
        }),
        connectionId: null,
        worktreeId: 'wt-1',
        tabId: 'tab-1'
      })
    )
    const paneKey = expectStablePaneSpawn()
    const leafId = paneKey.slice('tab-1:'.length)
    expect(mockSetTabLayout).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        ptyIdsByLeafId: { [leafId]: 'pty-1' }
      })
    )
    expect(mockSetTabLayout.mock.calls.at(-1)?.[1]).not.toHaveProperty('titlesByLeafId')
    expect(mockSpawn.mock.calls[0]?.[0]).toMatchObject({
      launchConfig: {
        agentCommand: "claude '--dangerously-skip-permissions'",
        agentArgs: '--dangerously-skip-permissions',
        agentEnv: {}
      },
      launchAgent: 'claude',
      launchToken: expect.stringMatching(UUID_RE)
    })
    expect(mockSpawn.mock.calls[0]?.[0].launchToken).toBe(
      mockSpawn.mock.calls[0]?.[0].env.ORCA_AGENT_LAUNCH_TOKEN
    )
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Nightly audit', {
      recordInteraction: false
    })
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-1')
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(mockSubscribeToPtyData).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(mockSubscribeToPtyExit).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(result).toMatchObject({ tabId: 'tab-1', ptyId: 'pty-1' })
  })

  it('records effective launch config returned by local PTY spawn', async () => {
    const effectiveLaunchConfig = {
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: { ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh' }
    }
    mockSpawn.mockResolvedValue({ id: 'pty-1', launchConfig: effectiveLaunchConfig })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    const paneKey = expectStablePaneSpawn()
    const leafId = paneKey.slice('tab-1:'.length)
    expect(mockRegisterAgentLaunchConfig).toHaveBeenLastCalledWith(paneKey, effectiveLaunchConfig, {
      agentType: 'claude',
      launchToken: mockSpawn.mock.calls[0]?.[0].env.ORCA_AGENT_LAUNCH_TOKEN,
      tabId: 'tab-1',
      leafId
    })
  })

  it('uses WSL launch quoting for Windows-path projects forced to WSL', async () => {
    state.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    state.repos = [{ id: 'repo-1', connectionId: null, path: 'C:\\Users\\jinwo\\repo' }]
    state.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: 'C:\\Users\\jinwo\\repo\\feature',
          displayName: 'feature'
        }
      ]
    }

    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: "don't use powershell quoting"
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:\\Users\\jinwo\\repo\\feature',
        command: "claude '--dangerously-skip-permissions' 'don'\\''t use powershell quoting'",
        connectionId: null,
        worktreeId: 'wt-1',
        tabId: 'tab-1'
      })
    )
  })

  it('pre-marks trust for agents with first-launch trust prompts', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockMarkTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/worktree'
    })
    expect(mockSpawn).toHaveBeenCalled()
  })

  it('parses agent status from hidden PTY output', async () => {
    const onAgentStatus = vi.fn()
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      onAgentStatus
    })

    const dataSidecar = mockSubscribeToPtyData.mock.calls[0]?.[1] as (data: string) => void
    dataSidecar('\x1b]9999;{"state":"done","prompt":"ok","agentType":"codex"}\x07')

    const paneKey = expectStablePaneSpawn()
    expect(state.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' }),
      undefined,
      undefined,
      undefined,
      { launchToken: expect.stringMatching(UUID_RE) }
    )
    expect(onAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' })
    )
  })

  it('seeds a working status for Command Code prompt launches', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'check the status spinner'
    })

    const paneKey = expectStablePaneSpawn()
    expect(state.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      {
        state: 'working',
        prompt: 'check the status spinner',
        agentType: 'command-code'
      },
      undefined,
      undefined,
      undefined,
      {
        launchConfig: {
          agentCommand: "command-code --trust '--yolo'",
          agentArgs: '--yolo',
          agentEnv: {}
        },
        launchToken: expect.stringMatching(UUID_RE)
      }
    )
  })

  it('uses a sidecar exit watcher so completion survives terminal attachment', async () => {
    const unsubscribe = vi.fn()
    mockSubscribeToPtyExit.mockReturnValue(unsubscribe)
    const onExit = vi.fn()
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      onExit
    })

    const sidecar = mockSubscribeToPtyExit.mock.calls[0]?.[1] as (code: number) => void
    sidecar(0)

    expect(state.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-1')
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(expect.stringMatching(/^tab-1:/))
    expect(onExit).toHaveBeenCalledWith('pty-1', 0)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('removes the inactive tab if PTY spawn fails', async () => {
    mockSpawn.mockRejectedValueOnce(new Error('spawn failed'))
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('spawn failed')

    expect(mockCloseTab).toHaveBeenCalledWith('tab-1', { recordInteraction: false })
    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
  })

  it('submits prompts for stdin-after-start agents in background mode', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "aider '--yes-always'" })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'run the automation',
        agent: 'aider',
        submit: true
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

  it('waits for shell-ready for SSH background Codex native prefill commands without a hint', async () => {
    vi.useFakeTimers()
    try {
      state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
      state.settings = {
        agentCmdOverrides: { codex: "codex --prefill 'draft from override'" },
        activeRuntimeEnvironmentId: null
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
    state.settings = { agentCmdOverrides: {}, activeRuntimeEnvironmentId: 'env-1' }
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    const params = mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params
    const paneKey = params?.env?.ORCA_PANE_KEY
    const leafId = typeof paneKey === 'string' ? paneKey.slice('tab-1:'.length) : ''
    expect(leafId).toMatch(UUID_RE)
    expect(mockRegisterAgentLaunchConfig).toHaveBeenCalledWith(
      `tab-1:${leafId}`,
      {
        agentCommand: "claude '--dangerously-skip-permissions'",
        agentArgs: '--dangerously-skip-permissions',
        agentEnv: {}
      },
      {
        agentType: 'claude',
        launchToken: expect.stringMatching(UUID_RE),
        tabId: 'tab-1',
        leafId
      }
    )
    expect(mockSetTabLayout).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        ptyIdsByLeafId: { [leafId]: 'remote:env-1@@terminal-1' }
      })
    )
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.create',
      params: expect.objectContaining({
        worktree: 'id:wt-1',
        command: "claude '--dangerously-skip-permissions' 'run the automation'",
        launchAgent: 'claude',
        env: expect.objectContaining({
          ORCA_PANE_KEY: `tab-1:${leafId}`,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1'
        }),
        tabId: 'tab-1',
        leafId,
        focus: false
      }),
      timeoutMs: 15_000
    })
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith('tab-1', 'remote:env-1@@terminal-1')
    expect(mockRegisterEagerPtyBuffer).not.toHaveBeenCalled()
    expect(mockRuntimeEnvironmentSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex',
        params: {}
      }),
      expect.any(Object)
    )
    expect(result).toMatchObject({ tabId: 'tab-1', ptyId: 'remote:env-1@@terminal-1' })
  })
})
