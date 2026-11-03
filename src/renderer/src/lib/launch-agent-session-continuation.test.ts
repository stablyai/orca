import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const launchAgentInNewTab = vi.hoisted(() => vi.fn())
const writeClipboardText = vi.hoisted(() => vi.fn(async () => undefined))
const ensureDetectedAgentsForWorktree = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
const store: {
  settings: { disabledTuiAgents: string[]; nativeChatProviders?: Readonly<Record<string, boolean>> }
  getKnownWorktreeById: () => undefined
} = vi.hoisted(() => ({
  settings: { disabledTuiAgents: [] },
  getKnownWorktreeById: () => undefined
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude' }],
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))
vi.mock('@/lib/agent-detection-target-inventory', () => ({
  ensureDetectedAgentsForWorktree,
  // A declined chat falls back to a terminal only where the agent's CLI was detected.
  readAgentInventoryForTarget: () => ({ ids: ['claude'], state: 'successful' })
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('./host-chat-program-acquisition', () => ({
  acquireAgentLaunchChoices: async (_: unknown, run: () => unknown) => {
    const detected = await run()
    return { detected, offered: detected }
  }
}))
vi.mock('./host-chat-program', () => ({ agentChoicePending: () => false }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => ({ supported: false, reason: 'wsl' }))
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, value),
      fallback
    )
}))

describe('launchAgentSessionContinuation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings.disabledTuiAgents = []
    ensureDetectedAgentsForWorktree.mockResolvedValue(['claude', 'codex'])
    launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-new' },
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    writeClipboardText.mockClear()
    vi.stubGlobal('window', {
      api: {
        ui: { writeClipboardText }
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['terminal-tui', 'structured-native-chat'] as const)(
    'forwards configured setup through the existing %s route',
    async (route) => {
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
      const sessionOptions = { model: 'team-model', effort: 'high', permissionMode: 'full-access' }
      const terminalInputs = route === 'terminal-tui' ? { agentArgs: '--add-dir docs' } : {}
      await launchAgentSessionContinuation({
        agent: 'codex',
        prompt: 'continue',
        worktreeId: 'wt-1',
        launchSource: 'sidebar',
        launchChoice: { agent: 'codex', route },
        sessionOptions,
        ...terminalInputs
      })
      expect(launchAgentInNewTab).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'continue',
          sessionOptions,
          ...terminalInputs,
          agentSessionLaunchPlan: expect.objectContaining({ route, launchOptions: sessionOptions })
        })
      )
      if (route === 'structured-native-chat') {
        expect(launchAgentInNewTab.mock.calls[0]?.[0]).not.toHaveProperty('agentArgs')
      }
    }
  )
})
