import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab'

const launchAgentInNewTab = vi.hoisted(() => vi.fn<(args: LaunchAgentInNewTabArgs) => unknown>())
const writeClipboardText = vi.hoisted(() => vi.fn(async () => undefined))
const connectionId = vi.hoisted(() => ({ value: null as string | null }))
const runtimeEnvironmentId = vi.hoisted(() => ({ value: null as string | null }))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
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
      surface: { kind: 'local-terminal', tabId: 'tab-new' },
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    writeClipboardText.mockClear()
    vi.stubGlobal('window', {
      api: {
        agentTrust: { markTrusted: vi.fn(async () => undefined) },
        ui: { writeClipboardText }
      }
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
        promptDelivery: 'draft'
      })
    )
  })

  describe.each([
    { host: 'local', connection: null, environment: null },
    { host: 'SSH', connection: 'ssh-1', environment: null },
    { host: 'paired runtime', connection: null, environment: 'runtime-1' }
  ])('$host continuation feedback', ({ connection, environment }) => {
    it.each([
      {
        agent: 'claude' as const,
        delivery: 'draft',
        message:
          'Session context loaded as a draft in the new Claude session. Review it and press Enter to continue.'
      },
      {
        agent: 'codex' as const,
        delivery: 'submit-after-ready',
        message: 'Session context sent to Codex in a new session.'
      }
    ])(
      'describes $agent delivery only when its callback fires',
      async ({ agent, delivery, message }) => {
        connectionId.value = connection
        runtimeEnvironmentId.value = environment
        const { launchAgentSessionContinuation } =
          await import('./launch-agent-session-continuation')

        await launchAgentSessionContinuation({
          agent,
          prompt: 'continue the unfinished task',
          worktreeId: 'wt-1',
          workspacePath: '/workspace',
          launchSource: 'sidebar'
        })

        expect(toast.success).not.toHaveBeenCalled()
        const args = launchAgentInNewTab.mock.calls[0]?.[0]
        expect(args?.promptDelivery).toBe(delivery)
        expect(args?.onPromptDelivered).toBeTypeOf('function')
        args?.onPromptDelivered?.()
        expect(toast.success).toHaveBeenCalledExactlyOnceWith(message)
        expect(toast.error).not.toHaveBeenCalled()
        if (connection) {
          expect(store.ensureRemoteDetectedAgents).toHaveBeenCalledWith(connection)
          expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
        } else if (environment) {
          expect(store.ensureRuntimeDetectedAgents).toHaveBeenCalledWith(environment)
          expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
        } else {
          expect(store.ensureDetectedAgents).toHaveBeenCalledWith('wt-1')
        }
      }
    )
  })

  it.each(['launch failure', 'delivery rejection', 'already notified cancellation'] as const)(
    'does not report success on %s',
    async (failure) => {
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      launchAgentInNewTab.mockReturnValue(
        failure === 'launch failure'
          ? null
          : {
              promptDeliveryResult:
                failure === 'delivery rejection'
                  ? Promise.reject(new Error('delivery rejected'))
                  : Promise.resolve({ delivered: false, failureNotified: true })
            }
      )
      try {
        await launchAgentSessionContinuation({
          agent: 'codex',
          prompt: 'continue',
          worktreeId: 'wt-1',
          workspacePath: '/workspace',
          launchSource: 'sidebar'
        })
        if (failure === 'already notified cancellation') {
          expect(toast.error).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
        }
        expect(toast.success).not.toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    }
  )

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
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('distinguishes prompt delivery failure from terminal launch failure', async () => {
    launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-new' },
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

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', promptDelivery: 'submit-after-ready' })
    )
    expect(toast.success).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The new Codex session started, but its context could not be sent.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Copy prompt' }) })
      )
    )
  })

  it.each(['claude', 'codex'] as const)(
    'does not claim success when the %s paste went out unconfirmed',
    async (agent) => {
      // Regression (#22479): on Windows the composer-ready signal can never fire, so the paste
      // is written blind. Reporting that as a delivered handoff hid a prompt that never arrived.
      launchAgentInNewTab.mockImplementation(
        (args: {
          onPromptDelivered?: () => void
          onPromptDeliveryUnconfirmed?: () => void
        }): unknown => {
          args.onPromptDeliveryUnconfirmed?.()
          args.onPromptDelivered?.()
          return {
            surface: { kind: 'local-terminal', tabId: 'tab-new' },
            promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
          }
        }
      )
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

      await launchAgentSessionContinuation({
        agent,
        prompt: 'continue the unfinished task',
        worktreeId: 'wt-1',
        workspacePath: '/repo/worktree',
        launchSource: 'sidebar'
      })

      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.warning).toHaveBeenCalledWith(
        `Orca could not confirm ${agent === 'claude' ? 'Claude' : 'Codex'} received the session context. Check the new session, and paste it yourself if its input is empty.`,
        expect.objectContaining({ action: expect.objectContaining({ label: 'Copy prompt' }) })
      )
      toast.warning.mock.calls[0][1].action.onClick()
      expect(writeClipboardText).toHaveBeenCalledWith('continue the unfinished task')
    }
  )

  it('still reports a confirmed delivery as a success', async () => {
    launchAgentInNewTab.mockImplementation((args: { onPromptDelivered?: () => void }): unknown => {
      args.onPromptDelivered?.()
      return {
        surface: { kind: 'local-terminal', tabId: 'tab-new' },
        promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
      }
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')

    await launchAgentSessionContinuation({
      agent: 'codex',
      prompt: 'continue',
      worktreeId: 'wt-1',
      workspacePath: '/repo/worktree',
      launchSource: 'sidebar'
    })

    expect(toast.success).toHaveBeenCalledWith('Session context sent to Codex in a new session.')
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
