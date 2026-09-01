import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  AGENT_BACKGROUND_SESSION_UUID_RE as UUID_RE,
  createAgentBackgroundSessionTestState,
  expectReservedAgentBackgroundTabId,
  expectStableAgentBackgroundPaneSpawn,
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
const mockMarkTrusted = vi.fn()
const mockDispatchEvent = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockShowAutomationPromptNotSentToast = vi.fn()
const mockGetAgentLaunchPlatformForRepo = vi.fn<() => NodeJS.Platform>()
const LAUNCH_TOKEN = 'launch-token-1'
const LOCAL_LAUNCH_CONFIG = {
  agentCommand: "claude '--dangerously-skip-permissions'",
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}

function launchedOutcome(agent = 'claude', launchToken = LAUNCH_TOKEN) {
  return {
    status: 'launched' as const,
    receipt: {
      requestedAgent: agent,
      baseAgent: agent,
      notices: [],
      launchToken,
      catalogRevision: 1
    }
  }
}

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

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

// Why: the localized failure copy needs the i18n runtime; the launch flow tests
// only need a stable string to assert the failure path surfaces one.
vi.mock('@/lib/agent-launch-failure-copy', () => ({
  agentLaunchOutcomeErrorMessage: () => 'The agent could not be launched.'
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-background-session-timeout-toast', () => ({
  showAutomationPromptNotSentToast: mockShowAutomationPromptNotSentToast
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
      markTrusted: mockMarkTrusted,
      spawn: mockSpawn,
      write: mockWrite
    })
    mockSpawn.mockResolvedValue({
      id: 'pty-1',
      launchConfig: LOCAL_LAUNCH_CONFIG,
      agentLaunch: launchedOutcome()
    })
    mockRuntimeEnvironmentCall.mockResolvedValue({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-1',
          worktreeId: 'wt-1',
          title: null,
          agentLaunch: launchedOutcome()
        }
      }
    })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('spawns a host-resolved PTY and adopts it in an inactive tab', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    mockSpawn.mockResolvedValue({ id: 'pty-1', incarnationId: 'inc-fresh' })

    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      title: 'Nightly audit'
    })

    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    // A store-visible PTY-less run tab fresh-spawns a shell (#2989).
    expect(mockSpawn.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateTab.mock.invocationCallOrder[0] ?? 0
    )
    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      id: tabId,
      initialPtyId: 'pty-1',
      activate: false,
      recordInteraction: false
    })
    expect(mockDispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        detail: { worktreeId: 'wt-1', tabIds: [tabId] }
      })
    )
    expect(mockUpdateTabPtyId.mock.invocationCallOrder[0]).toBeLessThan(
      mockDispatchEvent.mock.invocationCallOrder[0] ?? 0
    )
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/worktree',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'run the automation'
        },
        env: expect.objectContaining({
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: 'wt-1'
        }),
        connectionId: null,
        worktreeId: 'wt-1',
        tabId
      })
    )
    const paneKey = expectStableAgentBackgroundPaneSpawn(mockSpawn)
    const leafId = paneKey.slice(`${tabId}:`.length)
    expect(mockSetTabLayout).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        ptyIdsByLeafId: { [leafId]: 'pty-1' }
      })
    )
    expect(mockSetTabLayout.mock.calls.at(-1)?.[1]).not.toHaveProperty('titlesByLeafId')
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith(tabId, 'Nightly audit', {
      recordInteraction: false
    })
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith(tabId, 'pty-1')
    // The incarnation rides along so a relay-recycled id cannot drain the previous owner's exit
    // into this handler and tear the session down right after launch.
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledWith(
      'pty-1',
      expect.any(Function),
      'inc-fresh'
    )
    expect(mockSubscribeToPtyData).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(mockSubscribeToPtyExit).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(result).toMatchObject({ tabId, paneKey, ptyId: 'pty-1' })
  })

  it('sends identity and prompt only — never a client command, config, or launch token', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    const spawnArgs = mockSpawn.mock.calls[0]?.[0]
    expect(spawnArgs.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt: 'run the automation'
    })
    // The client resolves nothing: no command, launch config, agent-config, or
    // client-minted token — and never the launch-token env var.
    expect(spawnArgs).not.toHaveProperty('command')
    expect(spawnArgs).not.toHaveProperty('launchConfig')
    expect(spawnArgs).not.toHaveProperty('launchToken')
    expect(spawnArgs).not.toHaveProperty('launchAgent')
    expect(spawnArgs.env).not.toHaveProperty('ORCA_AGENT_LAUNCH_TOKEN')
  })

  it('allows a bare-TUI launch when no prompt is supplied', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({ agent: 'claude', worktreeId: 'wt-1' })

    expect(mockSpawn.mock.calls[0]?.[0].agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt: '',
      allowEmptyPromptLaunch: true
    })
  })

  it('does not mount the tab while the explicit PTY spawn is unresolved', async () => {
    let resolveSpawn!: (result: unknown) => void
    mockSpawn.mockReturnValueOnce(
      new Promise((resolve) => {
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

    resolveSpawn({
      id: 'pty-slow',
      launchConfig: LOCAL_LAUNCH_CONFIG,
      agentLaunch: launchedOutcome()
    })
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
      if (args.method === 'terminal.create') {
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
        expect.objectContaining({ method: 'terminal.create' })
      )
    )
    state.worktreesByRepo['repo-1'] = []
    resolveCreate({
      ok: true,
      result: { terminal: { handle: 'terminal-after-close', worktreeId: 'wt-1', title: null } }
    })

    await expect(launch).resolves.toBeNull()
    expect(mockKill).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close',
        params: { terminal: 'terminal-after-close' }
      })
    )
  })

  it('launches a local WSL folder through wsl.exe', async () => {
    const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    state.worktreesByRepo['repo-1'] = []
    state.folderWorkspaces = [
      { id: 'fw-wsl', projectGroupId: 'grp-wsl', folderPath, connectionId: null }
    ]
    state.projectGroups = [{ id: 'grp-wsl', connectionId: null }]
    state.getKnownWorktreeById = (worktreeId: string) =>
      worktreeId === 'folder:fw-wsl' ? { id: worktreeId, path: folderPath } : undefined
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'folder:fw-wsl',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: folderPath,
        shellOverride: 'wsl.exe',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'run the automation'
        }
      })
    )
    expect(mockSpawn.mock.calls[0]?.[0]).not.toHaveProperty('command')
  })

  it('records the effective launch config and receipt token returned by local PTY spawn', async () => {
    const effectiveLaunchConfig = {
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: { ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh' }
    }
    mockSpawn.mockResolvedValue({
      id: 'pty-1',
      launchConfig: effectiveLaunchConfig,
      agentLaunch: launchedOutcome()
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    const paneKey = expectStableAgentBackgroundPaneSpawn(mockSpawn)
    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    const leafId = paneKey.slice(`${tabId}:`.length)
    expect(mockRegisterAgentLaunchConfig).toHaveBeenLastCalledWith(paneKey, effectiveLaunchConfig, {
      agentType: 'claude',
      launchToken: LAUNCH_TOKEN,
      tabId,
      leafId
    })
  })

  it('sends agentLaunch without any client command regardless of Windows/WSL projects', async () => {
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

    // Platform-specific launch command assembly is now host-side; the client
    // only names identity + prompt and lets the host quote for the target shell.
    const spawnArgs = mockSpawn.mock.calls[0]?.[0]
    expect(spawnArgs.cwd).toBe('C:\\Users\\jinwo\\repo\\feature')
    expect(spawnArgs).not.toHaveProperty('command')
    expect(spawnArgs.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt: "don't use powershell quoting"
    })
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
    expect(mockSpawn.mock.calls[0]?.[0].agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      prompt: 'run the automation'
    })
  })

  // Registry safety (oracle 16): a custom background agent must pre-mark trust
  // with its base harness's preset (a raw registry index would crash/degrade).
  it('pre-marks trust for a custom-based background agent using its base preset', async () => {
    const customId = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'
    state.settings.customTuiAgents = [{ id: customId, baseAgent: 'codex', label: 'My Codex' }]
    try {
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
      await launchAgentBackgroundSession({
        agent: customId,
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })

      expect(mockMarkTrusted).toHaveBeenCalledWith({
        preset: 'codex',
        workspacePath: '/repo/worktree'
      })
      // The client still names the requested (custom) identity; the host resolves it.
      expect(mockSpawn.mock.calls[0]?.[0].agentLaunch).toEqual({
        selection: { kind: 'agent', agent: customId },
        prompt: 'run the automation'
      })
    } finally {
      state.settings.customTuiAgents = []
    }
  })

  it('stamps hidden SSH status from renderer fallback using the receipt token', async () => {
    // Why: with main side-effect authority disabled, this sidecar is the only
    // OSC 9999 → store path for hidden SSH sessions.
    state.settings.terminalMainSideEffectAuthority = false
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    state.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])
    mockSpawn.mockResolvedValue({
      id: toAppSshPtyId('ssh-a', 'pty-1'),
      launchConfig: LOCAL_LAUNCH_CONFIG,
      agentLaunch: launchedOutcome()
    })
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

    const paneKey = expectStableAgentBackgroundPaneSpawn(mockSpawn)
    expect(state.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' }),
      undefined,
      undefined,
      { connectionId: 'ssh-a' },
      { launchToken: LAUNCH_TOKEN }
    )
    expect(onAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' })
    )
  })

  it('skips the duplicate OSC store write under main side-effect authority', async () => {
    // Why: main already routes OSC 9999 through the hook server to the store
    // (agentStatus:set); a second write here would race the authoritative
    // path. The automation onAgentStatus callback must still fire.
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

    expect(state.setAgentStatus).not.toHaveBeenCalled()
    expect(onAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', prompt: 'ok', agentType: 'codex' })
    )
  })

  it('stamps a working status for SSH Command Code prompt launches', async () => {
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    state.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])
    const commandCodeConfig = {
      agentCommand: "command-code --trust '--yolo'",
      agentArgs: '--yolo',
      agentEnv: {}
    }
    mockSpawn.mockResolvedValue({
      id: toAppSshPtyId('ssh-a', 'pty-1'),
      launchConfig: commandCodeConfig,
      agentLaunch: launchedOutcome('command-code')
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'check the status spinner'
    })

    const paneKey = expectStableAgentBackgroundPaneSpawn(mockSpawn)
    expect(state.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      {
        state: 'working',
        prompt: 'check the status spinner',
        agentType: 'command-code',
        // Why: Orca launched this hidden session, so the seed predates any provider signal (STA-4293).
        observation: expect.objectContaining({ origin: 'launch', kind: 'transition' })
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' },
      {
        launchConfig: {
          agentCommand: "command-code --trust '--yolo'",
          agentArgs: '--yolo',
          agentEnv: {}
        },
        launchToken: LAUNCH_TOKEN
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

    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    expect(state.clearTabPtyId).toHaveBeenCalledWith(tabId, 'pty-1')
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${tabId}:`))
    )
    expect(onExit).toHaveBeenCalledWith('pty-1', 0)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('removes the inactive tab if PTY spawn rejects', async () => {
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

  it('surfaces a pre-spawn agentLaunch failure and creates no terminal tab', async () => {
    // Why: the host resolved a typed failure before spawning — no PTY exists, so
    // the localized reason surfaces and the hidden tab is retired.
    mockSpawn.mockResolvedValueOnce({
      agentLaunch: { status: 'failed', failure: { code: 'unknown_agent' } }
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('The agent could not be launched.')

    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
    expect(mockKill).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('passes the prompt through agentLaunch for stdin-after-start agents', async () => {
    // Why: the host owns prompt delivery per the resolved base agent's injection
    // mode — including the readiness-writer followup for stdin-after-start agents.
    mockSpawn.mockResolvedValue({
      id: 'pty-1',
      launchConfig: LOCAL_LAUNCH_CONFIG,
      agentLaunch: launchedOutcome('aider'),
      // The host could not fold the prompt into the launch command, so it hands
      // it back for the renderer's readiness-gated paste writer.
      followupPrompt: 'run the automation'
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn.mock.calls[0]?.[0].agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'aider' },
      prompt: 'run the automation'
    })
    // The renderer delivers the host-returned followup prompt via post-ready paste.
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: expectReservedAgentBackgroundTabId(mockSpawn),
        content: 'run the automation',
        agent: 'aider',
        submit: true
      })
    )
  })

  it('does not paste a followup when the host folded the prompt into the command', async () => {
    // argv/flag agents carry the prompt in the launch command, so the host
    // returns no followupPrompt and the renderer must not paste one.
    mockSpawn.mockResolvedValue({
      id: 'pty-1',
      launchConfig: LOCAL_LAUNCH_CONFIG,
      agentLaunch: launchedOutcome('claude')
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('routes SSH background launches through agentLaunch without a client-side write', async () => {
    // Why (U3): the host sets commandDelivery=provider and the SSH provider
    // delivers the resolved command server-side — the renderer never writes it.
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      title: 'Nightly audit'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'run the automation'
        }
      })
    )
    expect(mockSpawn.mock.calls[0]?.[0]).not.toHaveProperty('command')
    expect(mockSpawn.mock.calls[0]?.[0]).not.toHaveProperty('startupCommandDelivery')
    expect(mockWrite).not.toHaveBeenCalled()
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
    const tabId = params?.tabId
    const leafId = params?.leafId
    expect(tabId).toMatch(UUID_RE)
    expect(leafId).toMatch(UUID_RE)
    // Runtime terminal-create is receipt-only: no client command/config/token,
    // and no client-side launch-config registration.
    expect(mockRegisterAgentLaunchConfig).not.toHaveBeenCalled()
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
      method: 'terminal.create',
      params: expect.objectContaining({
        worktree: 'id:wt-1',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'run the automation'
        },
        env: expect.objectContaining({
          ORCA_PANE_KEY: `${tabId}:${leafId}`,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: 'wt-1'
        }),
        tabId,
        leafId,
        presentation: 'background'
      }),
      timeoutMs: 15_000
    })
    expect(mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params).not.toHaveProperty('command')
    expect(mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params).not.toHaveProperty('launchAgent')
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

  it('surfaces a pre-spawn runtime agentLaunch failure and creates no terminal', async () => {
    state.settings = {
      agentCmdOverrides: {},
      activeRuntimeEnvironmentId: 'env-1',
      terminalMainSideEffectAuthority: undefined
    }
    mockRuntimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { agentLaunch: { status: 'rejected', requestError: { code: 'untrusted_reference' } } }
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation'
      })
    ).rejects.toThrow('The agent could not be launched.')

    // No terminal handle was returned, so nothing to close and no tab adoption.
    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
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
    const tabId = mockRuntimeEnvironmentCall.mock.calls[0]?.[0]?.params?.tabId
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
