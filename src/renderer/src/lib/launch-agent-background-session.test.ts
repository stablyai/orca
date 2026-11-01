import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type {
  registerEagerPtyBuffer,
  subscribeToPtyExit
} from '@/components/terminal-pane/pty-dispatcher'
import type { createTestStore } from '@/store/slices/store-test-helpers'
import type { AppState } from '@/store/types'
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
const mockRegisterEagerPtyBuffer = vi.fn<typeof registerEagerPtyBuffer>()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn<typeof subscribeToPtyExit>()
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
let bindingStore: ReturnType<typeof createTestStore> | null = null

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => bindingStore?.getState() ?? currentStoreState,
    subscribe: vi.fn((listener: (state: AppState, previous: AppState) => void) =>
      bindingStore ? bindingStore.subscribe(listener) : () => {}
    )
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
    bindingStore = null
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

  it('spawns a PTY first and creates the inactive tab already bound to it', async () => {
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
        command: "claude '--dangerously-skip-permissions' 'run the automation'",
        env: expect.objectContaining({
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: 'wt-1',
          DISABLE_AUTOUPDATER: '1'
        }),
        connectionId: null,
        worktreeId: 'wt-1',
        tabId,
        placement: { kind: 'new-tab', row: { customTitle: 'Nightly audit' } }
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
    // Keep incarnation so recycled relay IDs cannot deliver a prior owner’s exit into the new session.
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledWith(
      'pty-1',
      expect.any(Function),
      'inc-fresh'
    )
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

  it('stamps hidden SSH status from renderer fallback when the kill switch is off', async () => {
    // With main authority disabled, this hidden SSH sidecar is the sole OSC 9999 store writer.
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
    // Main already owns OSC 9999 store writes; avoid races while retaining automation completion callbacks.
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

    const sidecar = mockSubscribeToPtyExit.mock.calls[0]?.[1]
    if (!sidecar) {
      throw new Error('Background exit sidecar was not registered')
    }
    sidecar(0, { hadPrimary: true })

    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    expect(state.clearTabPtyId).toHaveBeenCalledWith(tabId, 'pty-1')
    expect(state.clearAgentLaunchConfig).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${tabId}:`))
    )
    expect(onExit).toHaveBeenCalledWith('pty-1', 0)
    expect(unsubscribe).toHaveBeenCalled()
    expect(state.markUnverifiedPtyLoss).not.toHaveBeenCalled()
  })

  it.each(['eager', 'persistent sidecar'] as const)(
    'retains a closing background binding through %s completion but clears an ordinary exit once',
    async (entrypoint) => {
      const { createTestStore, seedStore, makeWorktree, TEST_REPO } =
        await import('@/store/slices/store-test-helpers')
      const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
      const store = createTestStore()
      bindingStore = store
      seedStore(store, {
        worktreesByRepo: {
          [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })]
        }
      })
      const unsubscribeData = vi.fn()
      const unsubscribeExit = vi.fn()
      mockSubscribeToPtyData.mockReturnValue(unsubscribeData)
      mockSubscribeToPtyExit.mockReturnValue(unsubscribeExit)
      const onExit = vi.fn()
      const result = await launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation',
        onExit
      })
      if (!result) {
        throw new Error('Background launch did not create a terminal')
      }
      const tab = store.getState().tabsByWorktree['wt-1'].find((tab) => tab.id === result.tabId)
      const layout = store.getState().terminalLayoutsByTabId[result.tabId]
      expect(tab?.ptyId).toBe('pty-1')
      expect(store.getState().ptyIdsByTabId[result.tabId]).toEqual(['pty-1'])
      expect(store.getState().lastKnownRelayPtyIdByTabId[result.tabId]).toBe('pty-1')
      expect(store.getState().agentLaunchConfigByPaneKey[result.paneKey]).toBeDefined()

      const eager = mockRegisterEagerPtyBuffer.mock.calls[0]?.[1]
      const sidecar = mockSubscribeToPtyExit.mock.calls[0]?.[1]
      if (!eager || !sidecar) {
        throw new Error('Background exit observers were not registered')
      }
      const exitOptions = { preserveRendererBinding: 'closing' as const }
      if (entrypoint === 'eager') {
        eager(result.ptyId, 0, exitOptions)
      } else {
        sidecar(0, { hadPrimary: true, exitOptions })
      }
      // A primary and the captured persistent sidecar may both see the same physical exit.
      sidecar(0, { hadPrimary: true, exitOptions })
      expect(onExit).toHaveBeenCalledExactlyOnceWith('pty-1', 0, exitOptions)
      expect(onExit.mock.calls[0]?.[2]).toBe(exitOptions)
      expect(unsubscribeData).toHaveBeenCalledOnce()
      expect(unsubscribeExit).toHaveBeenCalledOnce()
      expect(store.getState().agentLaunchConfigByPaneKey[result.paneKey]).toBeUndefined()
      expect(store.getState().tabsByWorktree['wt-1'].find((t) => t.id === result.tabId)).toBe(tab)
      expect(store.getState().terminalLayoutsByTabId[result.tabId]).toBe(layout)
      expect(store.getState().ptyIdsByTabId[result.tabId]).toEqual(['pty-1'])
      expect(store.getState().lastKnownRelayPtyIdByTabId[result.tabId]).toBe('pty-1')
      expect(store.getState().unverifiedPtyLossTabIds[result.tabId]).toBeUndefined()

      mockSpawn.mockResolvedValueOnce({ id: 'pty-ordinary' })
      const ordinaryExit = vi.fn()
      const ordinary = await launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'finish normally',
        onExit: ordinaryExit
      })
      if (!ordinary) {
        throw new Error('Ordinary background launch did not create a terminal')
      }
      const ordinaryEager = mockRegisterEagerPtyBuffer.mock.calls[1]?.[1]
      const ordinarySidecar = mockSubscribeToPtyExit.mock.calls[1]?.[1]
      if (!ordinaryEager || !ordinarySidecar) {
        throw new Error('Ordinary exit observers missing')
      }
      if (entrypoint === 'eager') {
        ordinaryEager(ordinary.ptyId, 0)
      } else {
        ordinarySidecar(0, { hadPrimary: true })
      }
      ordinarySidecar(0, { hadPrimary: true })
      expect(ordinaryExit).toHaveBeenCalledExactlyOnceWith('pty-ordinary', 0)
      expect(unsubscribeData).toHaveBeenCalledTimes(2)
      expect(unsubscribeExit).toHaveBeenCalledTimes(2)
      expect(store.getState().agentLaunchConfigByPaneKey[ordinary.paneKey]).toBeUndefined()
      expect(
        store.getState().tabsByWorktree['wt-1'].find((t) => t.id === ordinary.tabId)?.ptyId
      ).toBeNull()
      expect(store.getState().ptyIdsByTabId[ordinary.tabId]).toEqual([])
      expect(store.getState().lastKnownRelayPtyIdByTabId[ordinary.tabId]).toBeUndefined()
      expect(store.getState().unverifiedPtyLossTabIds[ordinary.tabId]).toBeUndefined()
      expect(store.getState().tabsByWorktree['wt-1'].find((t) => t.id === result.tabId)).toBe(tab)
      expect(mockSpawn).toHaveBeenCalledTimes(2)
      result.terminalOwnership?.release()
      ordinary.terminalOwnership?.release()
    }
  )

  it('keeps the tab bound to its PTY when contact was lost rather than observed', async () => {
    // Synthetic -1 loss retires transport only; retain bindings for reconnect adoption and orphan-cleanup protection.
    mockSubscribeToPtyExit.mockReturnValue(vi.fn())
    const onExit = vi.fn()
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      onExit
    })

    const sidecar = mockSubscribeToPtyExit.mock.calls[0]?.[1]
    if (!sidecar) {
      throw new Error('Background exit sidecar was not registered')
    }
    sidecar(-1, { hadPrimary: true })

    const tabId = expectReservedAgentBackgroundTabId(mockSpawn)
    expect(state.clearTabPtyId).not.toHaveBeenCalled()
    expect(state.markUnverifiedPtyLoss).toHaveBeenCalledWith(tabId)
    expect(onExit).toHaveBeenCalledWith('pty-1', -1)
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
      expect.objectContaining({
        command: "aider '--yes-always' '--no-check-update' '--no-show-release-notes'"
      })
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

  it("keeps this client's Git Bash setting off a Windows Orca server's launch", async () => {
    mockGetAgentLaunchPlatformForRepo.mockReturnValue('win32')
    mockHostKind.mockReturnValueOnce('runtime')
    Object.assign(state.settings, { terminalWindowsShell: 'bash.exe' })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'hermes',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('powershell.exe -NoProfile -EncodedCommand')
      })
    )
  })
})
