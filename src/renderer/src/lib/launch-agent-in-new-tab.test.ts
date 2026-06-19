import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockSetActiveTabType = vi.fn()
const mockSetTabBarOrder = vi.fn()
const mockSetAgentStatus = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockTrack = vi.fn()

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const store = {
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
  setAgentStatus: mockSetAgentStatus
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

const mockToastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: mockToastError }
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
    store.settings = { agentCmdOverrides: {}, activeRuntimeEnvironmentId: null }
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
    store.settings = { agentCmdOverrides: {}, activeRuntimeEnvironmentId: 'web-runtime' }
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

  it('surfaces a toast when host agent launch fails in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockCreateWebRuntimeSessionTerminal.mockResolvedValue(false)
    store.settings = { agentCmdOverrides: {}, activeRuntimeEnvironmentId: 'web-runtime' }
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

  it('uses WSL launch quoting by default for Windows-path projects forced to WSL', async () => {
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

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

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

  it('seeds working after Command Code submit-after-ready prompt delivery', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = { 'tab-1': { activeLeafId: LEAF_ID } }
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

    launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    await Promise.resolve()

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
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
