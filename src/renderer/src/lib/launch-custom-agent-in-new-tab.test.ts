import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  getAgentLaunchPlatformForRepo: vi.fn(() => 'linux' as NodeJS.Platform),
  getExecutionHostIdForWorktree: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  toastError: vi.fn()
}))

const codexLunaProfile = {
  id: 'codex-luna',
  name: 'Codex Luna',
  executable: 'codex',
  args: ['--model', 'luna']
}
const genericProfile = {
  id: 'dhimanex',
  name: 'Dhimanex',
  executable: 'dhimanex',
  args: ['--fast']
}

const store = {
  settings: {
    terminalWindowsShell: 'powershell.exe',
    customAgentProfiles: [codexLunaProfile, genericProfile]
  },
  sshConnectionStates: new Map(),
  sshStateByEnvironment: new Map(),
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  folderWorkspaces: [] as { id: string; folderPath: string }[],
  worktreesByRepo: {},
  allWorktrees: vi.fn(() => [{ id: 'wt-1', repoId: 'repo-1' }]),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  createTab: mocks.createTab,
  queueTabStartupCommand: mocks.queueTabStartupCommand,
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: mocks.setTabBarOrder
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/agent-launch-platform', () => ({
  getAgentLaunchPlatformForRepo: mocks.getAgentLaunchPlatformForRepo
}))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(() => ['tab-1'])
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

describe('launchCustomAgentInNewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createTab.mockReturnValue({ id: 'tab-1' })
    mocks.getAgentLaunchPlatformForRepo.mockReturnValue('linux')
    mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    store.settings.terminalWindowsShell = 'powershell.exe'
    store.sshConnectionStates.clear()
    store.sshStateByEnvironment.clear()
    store.folderWorkspaces = []
  })

  it('launches a Codex variant with exact profile argv', async () => {
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')

    launchCustomAgentInNewTab({ profileId: 'codex-luna', worktreeId: 'wt-1' })

    expect(mocks.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      quickCommandLabel: 'Codex Luna',
      viewMode: 'terminal'
    })
    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: "'codex' '--model' 'luna'"
    })
  })

  it('launches a generic profile without claiming built-in identity', async () => {
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')

    expect(launchCustomAgentInNewTab({ profileId: 'dhimanex', worktreeId: 'wt-1' })).toEqual({
      tabId: 'tab-1'
    })
    expect(mocks.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      quickCommandLabel: 'Dhimanex',
      viewMode: 'terminal'
    })
    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: "'dhimanex' '--fast'"
    })
  })

  it('queues the one-shot argv environment for native Windows', async () => {
    mocks.getAgentLaunchPlatformForRepo.mockReturnValue('win32')
    store.settings.terminalWindowsShell = 'cmd.exe'
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')

    launchCustomAgentInNewTab({ profileId: 'dhimanex', worktreeId: 'wt-1' })

    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: expect.stringMatching(/^powershell\.exe .* & set "/),
      env: { ORCA_CUSTOM_AGENT_WINDOWS_ARGV_V1: expect.any(String) }
    })
  })

  it('uses the known platform for Linux SSH and folder workspaces', async () => {
    mocks.getExecutionHostIdForWorktree.mockReturnValue('ssh:folder-host')
    store.sshConnectionStates.set('folder-host', {
      targetId: 'folder-host',
      remotePlatform: 'linux'
    })
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')

    launchCustomAgentInNewTab({ profileId: 'codex-luna', worktreeId: 'folder:docs' })

    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: "'codex' '--model' 'luna'"
    })
  })

  it('uses POSIX argv for a local WSL folder workspace', async () => {
    store.folderWorkspaces = [
      {
        id: 'wsl-folder',
        folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dhiman\\project'
      }
    ]
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')

    launchCustomAgentInNewTab({ profileId: 'codex-luna', worktreeId: 'folder:wsl-folder' })

    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: "'codex' '--model' 'luna'"
    })
  })

  it('fails closed on paired hosts and Windows SSH', async () => {
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')
    mocks.getExecutionHostIdForWorktree.mockReturnValue('runtime:server')
    expect(launchCustomAgentInNewTab({ profileId: 'codex-luna', worktreeId: 'wt-1' })).toBeNull()

    mocks.getExecutionHostIdForWorktree.mockReturnValue('ssh:windows-host')
    store.sshConnectionStates.set('windows-host', {
      targetId: 'windows-host',
      remotePlatform: 'win32'
    })
    expect(launchCustomAgentInNewTab({ profileId: 'codex-luna', worktreeId: 'wt-1' })).toBeNull()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('fails closed when the selected profile was removed', async () => {
    const { launchCustomAgentInNewTab } = await import('./launch-custom-agent-in-new-tab')

    expect(
      launchCustomAgentInNewTab({ profileId: 'removed-profile', worktreeId: 'wt-1' })
    ).toBeNull()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})
