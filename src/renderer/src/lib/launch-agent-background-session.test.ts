import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  AGENT_BACKGROUND_SESSION_UUID_RE as UUID_RE,
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
  })

  it('spawns a PTY first and creates the inactive tab already bound to it', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

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
        command: "claude '--dangerously-skip-permissions' 'run the automation'",
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
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith(tabId, 'Nightly audit', {
      recordInteraction: false
    })
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith(tabId, 'pty-1')
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(mockSubscribeToPtyData).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(mockSubscribeToPtyExit).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(result).toMatchObject({ tabId, paneKey, ptyId: 'pty-1' })
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

  it('launches into a folder workspace that is absent from worktreesByRepo throughout', async () => {
    // Folder workspaces never appear in worktreesByRepo.
    state.worktreesByRepo['repo-1'] = []
    state.folderWorkspaces = [
      { id: 'fw-1', projectGroupId: 'grp-1', folderPath: '/tmp/folder-workspace' }
    ]
    state.projectGroups = [{ id: 'grp-1', connectionId: null }]
    state.getKnownWorktreeById = (worktreeId: string) =>
      worktreeId === 'folder:fw-1'
        ? { id: 'folder:fw-1', path: '/tmp/folder-workspace' }
        : undefined
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    const launch = launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'folder:fw-1',
      prompt: 'run in a folder workspace'
    })

    await expect(launch).resolves.toMatchObject({ ptyId: 'pty-1' })
    expect(mockKill).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalledOnce()
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
        command: "claude '--dangerously-skip-permissions' 'run the automation'"
      })
    )
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

    const paneKey = expectStableAgentBackgroundPaneSpawn(mockSpawn)
    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    const leafId = paneKey.slice(`${tabId}:`.length)
    expect(mockRegisterAgentLaunchConfig).toHaveBeenLastCalledWith(paneKey, effectiveLaunchConfig, {
      agentType: 'claude',
      launchToken: mockSpawn.mock.calls[0]?.[0].env.ORCA_AGENT_LAUNCH_TOKEN,
      tabId,
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
        command: `claude '--dangerously-skip-permissions' 'don'"'"'t use powershell quoting'`,
        connectionId: null,
        worktreeId: 'wt-1',
        tabId: expect.stringMatching(UUID_RE)
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

  it('stamps hidden SSH status from renderer fallback when the kill switch is off', async () => {
    // Why: with main side-effect authority disabled, this sidecar is the only
    // OSC 9999 → store path for hidden SSH sessions.
    state.settings.terminalMainSideEffectAuthority = false
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    state.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])
    mockSpawn.mockResolvedValue({ id: toAppSshPtyId('ssh-a', 'pty-1') })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
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
      { launchToken: expect.stringMatching(UUID_RE) }
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
    mockSpawn.mockResolvedValue({ id: toAppSshPtyId('ssh-a', 'pty-1') })
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

    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    expect(state.clearTabPtyId).toHaveBeenCalledWith(tabId, 'pty-1')
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${tabId}:`))
    )
    expect(onExit).toHaveBeenCalledWith('pty-1', 0)
    expect(unsubscribe).toHaveBeenCalled()
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
        tabId: expectReservedAgentBackgroundTabId(mockSpawn),
        content: 'run the automation',
        agent: 'aider',
        submit: true
      })
    )
  })

  it('passes Hermes automation prompts through the native startup query', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'hermes',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('ORCA_HERMES_STARTUP_QUERY'),
        env: expect.objectContaining({ ORCA_HERMES_STARTUP_QUERY: 'run the automation' })
      })
    )
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('uses the configured cmd shell for Windows Hermes background launches', async () => {
    mockGetAgentLaunchPlatformForRepo.mockReturnValue('win32')
    Object.assign(state.settings, { terminalWindowsShell: 'cmd.exe' })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'hermes',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('powershell.exe -NoProfile -EncodedCommand'),
        env: expect.objectContaining({ ORCA_HERMES_STARTUP_QUERY: 'run the automation' })
      })
    )
  })
})
