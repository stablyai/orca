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
  settings: {
    agentCmdOverrides: {},
    personalizationPrompt: 'Prefer small, reviewed patches.',
    personalizationPromptMode: 'global' as const,
    agentPersonalizationPrompts: {}
  },
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  activeWorktreeId: 'wt-1',
  terminalLayoutsByTabId: {} as Record<string, { activeLeafId: string | null }>,
  createTab: mockCreateTab,
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

vi.mock('sonner', () => ({
  toast: { message: vi.fn() }
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

describe('launchAgentInNewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      personalizationPrompt: 'Prefer small, reviewed patches.',
      personalizationPromptMode: 'global',
      agentPersonalizationPrompts: {}
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.openFiles = []
    store.browserTabsByWorktree = {}
    store.tabBarOrderByWorktree = {}
    store.activeWorktreeId = 'wt-1'
    store.terminalLayoutsByTabId = {}
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
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
        command:
          "command-code --trust 'Custom instructions:\nPrefer small, reviewed patches.\n\nTask:\nfix the spinner'",
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
        command: 'command-code --trust'
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content:
          'Custom instructions:\nPrefer small, reviewed patches.\n\nTask:\nlarge generated prompt',
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

  it('prepends custom instructions to followup-agent pasted drafts', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: 'Refactor this module.',
      launchSource: 'diff_notes_send'
    })

    expect(result?.startupPlan.launchCommand).toBe('aider')
    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'aider',
      telemetry: {
        agent_kind: 'aider',
        launch_source: 'diff_notes_send',
        request_kind: 'new'
      }
    })
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        agent: 'aider',
        content:
          'Custom instructions:\nPrefer small, reviewed patches.\n\nTask:\nRefactor this module.'
      })
    )
  })
})
