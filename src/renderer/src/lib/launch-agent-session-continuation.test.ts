import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const launchAgentInNewTab = vi.hoisted(() => vi.fn())
const connectionId = vi.hoisted(() => ({ value: null as string | null }))
const runtimeEnvironmentId = vi.hoisted(() => ({ value: null as string | null }))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
const store = vi.hoisted(() => ({
  settings: { disabledTuiAgents: [] as string[] },
  ensureDetectedAgents: vi.fn(async () => ['claude', 'codex']),
  ensureRemoteDetectedAgents: vi.fn(async () => ['claude', 'codex']),
  ensureRuntimeDetectedAgents: vi.fn(async () => ['claude', 'codex'])
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => connectionId.value
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => runtimeEnvironmentId.value
}))
vi.mock('sonner', () => ({ toast }))
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
    connectionId.value = null
    runtimeEnvironmentId.value = null
    store.settings.disabledTuiAgents = []
    store.ensureDetectedAgents.mockResolvedValue(['claude', 'codex'])
    store.ensureRemoteDetectedAgents.mockResolvedValue(['claude', 'codex'])
    store.ensureRuntimeDetectedAgents.mockResolvedValue(['claude', 'codex'])
    launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-new',
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    vi.stubGlobal('window', {
      api: { agentTrust: { markTrusted: vi.fn(async () => undefined) } }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('launches any detected target Agent in the same workspace and cwd', async () => {
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue the unfinished task',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        workspacePath: '/repo/worktree',
        initialCwd: '/repo/worktree/packages/app',
        launchSource: 'terminal_context_menu'
      })
    ).resolves.toBe(true)

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        initialCwd: '/repo/worktree/packages/app',
        promptDelivery: 'submit-after-ready'
      })
    )
  })

  it('detects the target Agent on the SSH host that owns the workspace', async () => {
    connectionId.value = 'ssh-1'
    const { detectAgentSessionContinuationAgents } =
      await import('./launch-agent-session-continuation')

    await expect(detectAgentSessionContinuationAgents('wt-1')).resolves.toEqual(['claude', 'codex'])
    expect(store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('detects local Agents in the target worktree runtime', async () => {
    const { detectAgentSessionContinuationAgents } =
      await import('./launch-agent-session-continuation')

    await detectAgentSessionContinuationAgents('wt-1')

    expect(store.ensureDetectedAgents).toHaveBeenCalledWith('wt-1')
  })

  it('stops before launch when the selected Agent is unavailable', async () => {
    store.ensureDetectedAgents.mockResolvedValue(['claude'])
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await expect(
      launchAgentSessionContinuation({
        agent: 'codex',
        prompt: 'continue',
        worktreeId: 'wt-1',
        workspacePath: '/repo/worktree',
        launchSource: 'sidebar'
      })
    ).resolves.toBe(false)

    expect(launchAgentInNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Codex was not detected on this workspace host.')
  })

  it('distinguishes prompt delivery failure from terminal launch failure', async () => {
    launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-new',
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'continue',
      worktreeId: 'wt-1',
      workspacePath: '/repo/worktree',
      launchSource: 'sidebar'
    })

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The new Codex session started, but its context could not be sent.'
      )
    )
  })
})
