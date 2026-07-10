import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockSetActiveTabType = vi.fn()
const mockSetTabBarOrder = vi.fn()
const mockSetAgentStatus = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockSeedNativeChatLaunchPrompt = vi.fn()
const mockMarkNativeChatLaunchPromptFailed = vi.fn()
const mockTrack = vi.fn()
const mockToastMessage = vi.fn()

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

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
    experimentalNativeChat?: boolean
    openAgentTabsInChatByDefault?: boolean
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
  terminalLayoutsByTabId: {} as Record<string, { activeLeafId: string | null }>,
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: mockSetTabBarOrder,
  setAgentStatus: mockSetAgentStatus,
  seedNativeChatLaunchPrompt: mockSeedNativeChatLaunchPrompt,
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

const mockToastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { message: mockToastMessage, error: mockToastError }
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
  track: mockTrack,
  tuiAgentToAgentKind: (agent: string) => agent
}))

const mockCreateWebRuntimeSessionTerminal = vi.fn()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mockCreateWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockCreateWebRuntimeSessionTerminal.mockResolvedValue(true)
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
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('stamps the launched agent on the new tab for immediate provider icon bootstrap', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex'
    })
  })

  it('opens supported submit-after-ready launches in chat and seeds a launch prompt echo', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: expect.not.stringContaining('large generated prompt')
      })
    )
    expect(mockSeedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      text: 'large generated prompt',
      createdAt: expect.any(Number)
    })
  })

  it('keeps unsupported submit-after-ready launches in terminal mode and does not seed chat', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'grok',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'grok'
    })
    expect(mockSeedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('passes quick command labels only to locally-created agent tabs', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      quickCommandLabel: 'Review'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      quickCommandLabel: 'Review'
    })
  })

  it('delegates agent quick launch to the host runtime in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = {
      'wt-1': [
        { id: 'tab-1' },
        { id: 'stale-agent-tab', launchAgent: 'claude' } as { id: string; launchAgent: string }
      ]
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tabId: null,
        pasteDraftAfterLaunch: false
      })
    )
    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agent: 'claude'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal')
    expect(store.closeTab).toHaveBeenCalledWith('stale-agent-tab')
  })

  it('forwards prompt launch env and captured config to paired web runtime hosts', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: { codex: '--model gpt-5 --reasoning-effort high' },
      agentDefaultEnv: { codex: { CODEX_PROFILE: 'captured' } },
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tabId: null,
        pasteDraftAfterLaunch: false
      })
    )
    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'fix the spinner'",
      env: { CODEX_PROFILE: 'captured' },
      startupCommandDelivery: 'shell-ready',
      launchConfig: {
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchAgent: 'codex'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
  })

  it('surfaces a toast when host agent launch fails in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockCreateWebRuntimeSessionTerminal.mockResolvedValue(false)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    await Promise.resolve()
    expect(mockToastError).toHaveBeenCalledWith('Could not launch claude in a new terminal.')
    expect(mockSetActiveTabType).not.toHaveBeenCalled()
  })

  it('queues initial working status for Command Code argv prompt launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "command-code --trust '--yolo' 'fix the spinner'",
        initialAgentStatus: {
          agent: 'command-code',
          prompt: 'fix the spinner'
        }
      })
    )
  })

  it('does not track prompt-sent for argv prompt launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      launchSource: 'onboarding'
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not track prompt-sent for draft launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'review this before sending',
      promptDelivery: 'draft'
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
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
        command: 'codex "--model" "gpt-5" "fix the spinner"'
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
        command: "claude '--dangerously-skip-permissions' --prefill 'review Bob'\\''s change'"
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
        command: "claude '--dangerously-skip-permissions' --prefill 'review Bob'\\''s change'"
      })
    )
  })

  it('falls back to post-ready draft paste when a Windows inline draft would be too large', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

    expect(result).not.toHaveProperty('promptDeliveryResult')
    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions'"
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: prompt,
        agent: 'claude',
        submit: false,
        forcePaste: false
      })
    )
  })

  it('logs rejected non-deferred prompt delivery without exposing it to callers', async () => {
    const error = new Error('paste failed')
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mockPasteDraftWhenAgentReady.mockRejectedValue(error)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    try {
      const result = launchAgentInNewTab({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt,
        promptDelivery: 'draft',
        launchPlatform: 'win32'
      })

      expect(result).not.toHaveProperty('promptDeliveryResult')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(consoleError).toHaveBeenCalledWith('Prompt delivery failed after launch', error)
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('seeds working after Command Code submit-after-ready prompt delivery', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = { 'tab-1': { activeLeafId: LEAF_ID } }
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "command-code --trust '--yolo'"
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'large generated prompt',
        agent: 'command-code',
        submit: true,
        forcePaste: true
      })
    )
    expect(mockSetAgentStatus).toHaveBeenCalledWith(`tab-1:${LEAF_ID}`, {
      state: 'working',
      prompt: 'large generated prompt',
      agentType: 'command-code'
    })
    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not track prompt-sent when submit-after-ready delivery fails', async () => {
    mockPasteDraftWhenAgentReady.mockResolvedValue(false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    await Promise.resolve()

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('marks failed submit-after-ready delivery as notified after readiness timeout toast', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' } as never] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).toHaveBeenCalledWith(
      "Your prompt wasn't sent — paste it once the agent is ready."
    )
  })

  it('marks a cancelled submit-after-ready launch notified when the user closed the tab', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    // User closed the tab before the agent became ready — it is gone from the list.
    store.tabsByWorktree = { 'wt-1': [] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('marks a cancelled submit-after-ready launch notified when the user switched worktrees', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' } as never] }
    store.activeWorktreeId = 'wt-2'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('leaves a genuine launch failure unnotified so the caller surfaces it', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    // PTY never spawned: a real failure, not a user cancellation.
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: null } as never] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('queues per-launch CLI arguments without putting generated prompts in argv', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: "codex '--model' 'gpt-5.5'"
      })
    )
  })
})
