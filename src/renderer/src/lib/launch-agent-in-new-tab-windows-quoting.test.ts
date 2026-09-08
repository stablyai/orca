// Windows/WSL shell-quoting coverage for launchAgentInNewTab, split from
// launch-agent-in-new-tab.test.ts to keep both files within the lines budget.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    terminalWindowsShell?: string
  },
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
  sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
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
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<
    string,
    { activeLeafId: string | null; ptyIdsByLeafId?: Record<string, string> }
  >,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: vi.fn() }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab Windows shell quoting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.activeRepoId = 'repo-1'
    store.activeWorktreeId = 'wt-1'
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    store.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ]
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])
    store.transientClearedAgentStatusConnectionIds = {}
    store.worktreesByRepo = {
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
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.openFiles = []
    store.browserTabsByWorktree = {}
    store.tabBarOrderByWorktree = {}
    store.terminalLayoutsByTabId = {}
    store.ptyIdsByTabId = {}
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('uses the explicit startup shell platform when building draft launch commands', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: "review Bob's change",
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions' --prefill 'review Bob''s change'"
      })
    )
  })

  it('quotes local Windows default agent args for cmd.exe empty launches', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      launchPlatform: 'win32'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: 'claude "--dangerously-skip-permissions"'
      })
    )
  })

  it('keeps PowerShell quoting for local Windows default agent args', async () => {
    store.settings.terminalWindowsShell = 'powershell.exe'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      launchPlatform: 'win32'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions'"
      })
    )
  })

  it('quotes local Windows explicit agent args for cmd.exe prompt launches', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      agentArgs: '--model gpt-5',
      launchPlatform: 'win32'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: 'codex "--model" "gpt-5" "fix the spinner"',
        agentArgsOverride: '--model gpt-5'
      })
    )
  })

  it('quotes local Windows draft launches for Git Bash', async () => {
    store.settings.terminalWindowsShell = 'git-bash'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: "review Bob's change",
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: `claude '--dangerously-skip-permissions' --prefill 'review Bob'"'"'s change'`
      })
    )
  })

  it('does not use the local Windows shell setting for remote Windows launches', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: 'C:\\remote\\repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions'"
      })
    )
  })

  it('uses WSL launch quoting by default for Windows-path projects forced to WSL', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    store.repos = [{ id: 'repo-1', connectionId: null, path: 'C:\\Users\\jinwo\\repo' }]
    store.worktreesByRepo = {
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
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: "review Bob's change",
      promptDelivery: 'draft'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: `claude '--dangerously-skip-permissions' --prefill 'review Bob'"'"'s change'`
      })
    )
  })

  // Platform resolution lands on posix here because vitest's node environment does not
  // report Windows. This pins single-quote escaping of user-configured default agent args.
  it('escapes a single quote inside default agent args', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.settings.agentDefaultArgs = { codex: '--profile "don\'t"' }
    store.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    store.repos = [{ id: 'repo-1', connectionId: null, path: 'C:\\Users\\jinwo\\repo' }]
    store.worktreesByRepo = {
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
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    const queued = mockQueueTabStartupCommand.mock.calls.at(-1)?.[1] as { command: string }
    expect(queued.command).toContain(`'don'"'"'t'`)
    expect(queued.command).not.toContain("'don''t'")
  })
})
