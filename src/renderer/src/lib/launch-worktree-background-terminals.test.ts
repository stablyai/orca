import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockSetTabColor = vi.fn()
const mockSetTabLayout = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockClearTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockGetActiveRuntimeTarget = vi.fn()

let uuidIndex = 0

const setupLaunch = {
  runnerScriptPath: '/tmp/setup.sh',
  envVars: { ORCA_WORKTREE_PATH: '/repo/worktree' }
}

const state = {
  settings: { activeRuntimeEnvironmentId: null as string | null, setupScriptLaunchMode: 'new-tab' },
  repos: [{ id: 'repo-1', connectionId: null as string | null }],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'Worktree'
      }
    ]
  },
  tabsByWorktree: { 'wt-1': [] as { id: string }[] },
  allWorktrees: vi.fn(() => state.worktreesByRepo['repo-1'] ?? []),
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  setTabColor: mockSetTabColor,
  setTabLayout: mockSetTabLayout,
  updateTabPtyId: mockUpdateTabPtyId,
  clearTabPtyId: mockClearTabPtyId,
  closeTab: mockCloseTab
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => state.settings
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: mockGetActiveRuntimeTarget
}))

describe('launchWorktreeBackgroundTerminals', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    uuidIndex = 0
    state.settings = { activeRuntimeEnvironmentId: null, setupScriptLaunchMode: 'new-tab' }
    state.repos = [{ id: 'repo-1', connectionId: null }]
    state.worktreesByRepo['repo-1'] = [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'Worktree'
      }
    ]
    state.tabsByWorktree = { 'wt-1': [] }
    let tabIndex = 0
    mockCreateTab.mockImplementation(() => {
      const tab = { id: `tab-${++tabIndex}` }
      state.tabsByWorktree['wt-1'].push(tab)
      return tab
    })
    mockCloseTab.mockImplementation((tabId: string) => {
      state.tabsByWorktree['wt-1'] = state.tabsByWorktree['wt-1'].filter((tab) => tab.id !== tabId)
    })
    let ptyIndex = 0
    mockSpawn.mockImplementation(async () => ({ id: `pty-${++ptyIndex}` }))
    mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
    vi.stubGlobal('window', {
      api: {
        pty: {
          spawn: mockSpawn,
          kill: mockKill
        }
      }
    })
  })

  it('spawns default tabs and setup as inactive background terminals', async () => {
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    await launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: setupLaunch,
      defaultTabs: {
        runCommands: true,
        tabs: [{ title: 'Dev', color: '#f97316', command: 'pnpm dev' }]
      }
    })

    expect(mockCreateTab).toHaveBeenCalledTimes(2)
    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Dev', {
      recordInteraction: false
    })
    expect(mockSetTabColor).toHaveBeenCalledWith('tab-1', '#f97316')
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/repo/worktree',
        command: 'pnpm dev',
        connectionId: null,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: '00000000-0000-4000-8000-000000000001'
      })
    )
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /tmp/setup.sh',
        env: expect.objectContaining({ ORCA_WORKTREE_PATH: '/repo/worktree' }),
        tabId: 'tab-2',
        leafId: '00000000-0000-4000-8000-000000000002'
      })
    )
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-1')
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith('tab-2', 'pty-2')
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledTimes(2)
  })

  it('spawns setup in a split when setup launch mode requests a split', async () => {
    state.settings = { activeRuntimeEnvironmentId: null, setupScriptLaunchMode: 'split-horizontal' }
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    await launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: setupLaunch
    })

    expect(mockCreateTab).toHaveBeenCalledTimes(1)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tabId: 'tab-1',
        leafId: '00000000-0000-4000-8000-000000000001'
      })
    )
    expect(mockSpawn.mock.calls[0]?.[0]).not.toHaveProperty('command')
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /tmp/setup.sh',
        tabId: 'tab-1',
        leafId: '00000000-0000-4000-8000-000000000002'
      })
    )
    expect(mockSetTabLayout).toHaveBeenLastCalledWith(
      'tab-1',
      expect.objectContaining({
        root: expect.objectContaining({
          type: 'split',
          direction: 'horizontal'
        }),
        ptyIdsByLeafId: {
          '00000000-0000-4000-8000-000000000001': 'pty-1',
          '00000000-0000-4000-8000-000000000002': 'pty-2'
        },
        titlesByLeafId: { '00000000-0000-4000-8000-000000000002': 'Setup' }
      })
    )
  })

  it('spawns an initial terminal before a setup-only new-tab launch', async () => {
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    await launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: setupLaunch
    })

    expect(mockCreateTab).toHaveBeenCalledTimes(2)
    expect(mockSpawn.mock.calls[0]?.[0]).not.toHaveProperty('command')
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /tmp/setup.sh',
        tabId: 'tab-2',
        leafId: '00000000-0000-4000-8000-000000000002'
      })
    )
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith('tab-2', 'Setup', {
      recordInteraction: false
    })
  })

  it('uses Windows setup commands for Windows SSH runner paths', async () => {
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-windows' }]
    state.worktreesByRepo['repo-1'] = [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\repo\\worktree',
        displayName: 'Worktree'
      }
    ]
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    await launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: {
        runnerScriptPath: 'C:\\repo\\.git\\worktrees\\wt\\orca\\setup-runner.cmd',
        envVars: { ORCA_WORKTREE_PATH: 'C:\\repo\\worktree' }
      }
    })

    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'cmd.exe /c "C:\\repo\\.git\\worktrees\\wt\\orca\\setup-runner.cmd"',
        connectionId: 'ssh-windows'
      })
    )
  })

  it('still attempts setup when a default tab fails to spawn', async () => {
    const spawnError = new Error('pty unavailable')
    mockSpawn
      .mockRejectedValueOnce(spawnError)
      .mockResolvedValueOnce({ id: 'pty-initial' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    await launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: setupLaunch,
      defaultTabs: {
        runCommands: true,
        tabs: [{ title: 'Dev', command: 'pnpm dev' }]
      }
    })

    expect(mockCloseTab).toHaveBeenCalledWith('tab-1', { recordInteraction: false })
    expect(mockSpawn).toHaveBeenCalledTimes(3)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        command: 'bash /tmp/setup.sh',
        tabId: 'tab-3'
      })
    )
    expect(warn).toHaveBeenCalledWith(
      '[automations] Failed to launch workspace default tab:',
      spawnError
    )
    warn.mockRestore()
  })

  it('does not duplicate runtime-owned setup/defaultTabs handled by runtime create', async () => {
    mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    await launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: setupLaunch,
      defaultTabs: { runCommands: true, tabs: [{ title: 'Dev', command: 'pnpm dev' }] }
    })

    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('kills a PTY whose tab is closed before the spawn resolves', async () => {
    let resolveSpawn!: (result: { id: string }) => void
    mockSpawn.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        resolveSpawn = resolve
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    const launch = launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      defaultTabs: { runCommands: true, tabs: [{ command: 'pnpm dev' }] }
    })
    await vi.waitFor(() => expect(mockCreateTab).toHaveBeenCalledOnce())
    state.tabsByWorktree['wt-1'] = []
    resolveSpawn({ id: 'pty-after-close' })
    await launch

    expect(mockKill).toHaveBeenCalledWith('pty-after-close')
    expect(mockUpdateTabPtyId).not.toHaveBeenCalled()
    expect(mockRegisterEagerPtyBuffer).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('kills a late setup split PTY when its parent tab closes', async () => {
    state.settings = { activeRuntimeEnvironmentId: null, setupScriptLaunchMode: 'split-horizontal' }
    let resolveSetupSpawn!: (result: { id: string }) => void
    mockSpawn.mockResolvedValueOnce({ id: 'pty-primary' }).mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        resolveSetupSpawn = resolve
      })
    )
    const { launchWorktreeBackgroundTerminals } =
      await import('./launch-worktree-background-terminals')

    const launch = launchWorktreeBackgroundTerminals({
      worktreeId: 'wt-1',
      setup: setupLaunch
    })
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2))
    state.closeTab('tab-1')
    resolveSetupSpawn({ id: 'pty-setup-after-close' })
    await launch

    expect(mockKill).toHaveBeenCalledWith('pty-setup-after-close')
    expect(mockUpdateTabPtyId).toHaveBeenCalledTimes(1)
    expect(mockUpdateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-primary')
    expect(mockSetTabLayout).not.toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        ptyIdsByLeafId: expect.objectContaining({
          '00000000-0000-4000-8000-000000000002': 'pty-setup-after-close'
        })
      })
    )
  })
})
