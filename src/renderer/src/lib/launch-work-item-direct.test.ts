import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPasteDraftWhenAgentReady = vi.fn()
const mockActivateAndRevealWorktree = vi.fn()
const mockEnsureHooksConfirmed = vi.fn()
const mockCheckRuntimeHooks = vi.fn()

const store = {
  repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo' }],
  settings: {
    defaultTuiAgent: 'aider',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    personalizationPrompt: 'Prefer small, reviewed patches.',
    personalizationPromptMode: 'global' as const,
    agentPersonalizationPrompts: {}
  },
  ensureDetectedAgents: vi.fn(),
  createWorktree: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  setSidebarOpen: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mockActivateAndRevealWorktree
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: mockEnsureHooksConfirmed
}))

vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: mockCheckRuntimeHooks
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), message: vi.fn() }
}))

describe('launchWorkItemDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as { window?: unknown }).window = { api: { agentTrust: {} } }
    store.ensureDetectedAgents.mockResolvedValue(['aider'])
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-1', path: '/repo/wt-1' },
      setup: undefined
    })
    store.updateWorktreeMeta.mockResolvedValue(undefined)
    mockActivateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    mockEnsureHooksConfirmed.mockResolvedValue('run')
    mockCheckRuntimeHooks.mockResolvedValue({ hooks: null })
  })

  it('prepends custom instructions to work item draft paste paths', async () => {
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await launchWorkItemDirect({
      repoId: 'repo-1',
      item: {
        title: 'Fix regression',
        url: 'https://github.com/acme/repo/issues/42',
        type: 'issue',
        number: 42
      },
      openModalFallback: vi.fn(),
      launchSource: 'sidebar'
    })

    expect(mockActivateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: 'aider'
        })
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        agent: 'aider',
        content:
          'Custom instructions:\nPrefer small, reviewed patches.\n\nTask:\nhttps://github.com/acme/repo/issues/42'
      })
    )
  })
})
