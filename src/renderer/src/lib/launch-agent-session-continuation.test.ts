import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activateWorkspaceTabPaletteResult = vi.hoisted(() => vi.fn())
const launchAgentInNewTab = vi.hoisted(() => vi.fn())
const writeClipboardText = vi.hoisted(() => vi.fn(async () => undefined))
const connectionId = vi.hoisted(() => ({ value: null as string | null }))
const runtimeEnvironmentId = vi.hoisted(() => ({ value: null as string | null }))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
const store = vi.hoisted(() => {
  const unifiedTabsByWorktree: Record<
    string,
    { id: string; entityId: string; contentType: 'terminal'; groupId: string; worktreeId: string }[]
  > = {}
  return {
    getKnownWorktreeById: vi.fn(() => ({ hostId: 'local' })),
    unifiedTabsByWorktree,
    settings: { disabledTuiAgents: [] as string[] },
    ensureDetectedAgents: vi.fn(async () => ['claude', 'codex']),
    ensureRemoteDetectedAgents: vi.fn(async () => ['claude', 'codex']),
    ensureRuntimeDetectedAgents: vi.fn(async () => ['claude', 'codex'])
  }
})

vi.mock('@/lib/workspace-tab-palette-activation', () => ({ activateWorkspaceTabPaletteResult }))
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
    store.unifiedTabsByWorktree = {}
    store.getKnownWorktreeById.mockReturnValue({ hostId: 'local' })
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

  it.each(['claude', 'codex'] as const)(
    'describes confirmed %s continuation delivery accurately',
    async (agent) => {
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
      await launchAgentSessionContinuation({
        agent,
        prompt: 'continue',
        worktreeId: 'wt-1',
        launchSource: 'sidebar'
      })
      launchAgentInNewTab.mock.calls[0][0].onPromptDelivered()
      await Promise.resolve()
      expect(toast.success).toHaveBeenCalledWith(
        agent === 'claude'
          ? 'Session context loaded as a draft in the new Claude session. Review it and press Enter to continue.'
          : 'Session context sent to Codex in a new session.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Open session' }) })
      )
    }
  )

  it.each(['wt-1', 'folder:folder-1'])(
    'opens the exact new session in %s after a synchronous delivery callback',
    async (worktreeId) => {
      store.getKnownWorktreeById.mockReturnValue({ hostId: 'ssh-host' })
      launchAgentInNewTab.mockImplementation((args) => {
        args.onCreatedTab('tab-new')
        args.onPromptDelivered()
        return { surface: { kind: 'local-terminal', tabId: 'tab-new' } }
      })
      const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
      await launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue',
        worktreeId,
        launchSource: 'sidebar'
      })
      store.unifiedTabsByWorktree[worktreeId] = [
        {
          id: 'unified-new',
          entityId: 'tab-new',
          contentType: 'terminal',
          groupId: 'moved-group',
          worktreeId
        }
      ]
      toast.success.mock.calls[0][1].action.onClick()
      expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith({
        id: 'unified-new',
        tabId: 'unified-new',
        entityId: 'tab-new',
        contentType: 'terminal',
        groupId: 'moved-group',
        worktreeId,
        executionHostId: 'ssh-host'
      })
      store.unifiedTabsByWorktree[worktreeId] = []
      toast.success.mock.calls[0][1].action.onClick()
      expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledOnce()
    }
  )

  it('uses the host-returned tab identity for a paired continuation', async () => {
    launchAgentInNewTab.mockImplementation((args) => {
      args.onCreatedTab('web-terminal-host-new')
      args.onPromptDelivered()
      return { surface: { kind: 'host-published' } }
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    await launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue',
      worktreeId: 'wt-1',
      launchSource: 'sidebar'
    })
    store.unifiedTabsByWorktree['wt-1'] = [
      {
        id: 'web-terminal-host-new',
        entityId: 'web-terminal-host-new',
        contentType: 'terminal',
        groupId: 'host-group',
        worktreeId: 'wt-1'
      }
    ]
    toast.success.mock.calls[0][1].action.onClick()
    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'web-terminal-host-new', groupId: 'host-group' })
    )
  })

  it('omits the navigation action when an older paired host supplies no tab identity', async () => {
    launchAgentInNewTab.mockImplementation((args) => {
      args.onPromptDelivered()
      return { surface: { kind: 'host-published' } }
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    await launchAgentSessionContinuation({
      agent: 'claude',
      prompt: 'continue',
      worktreeId: 'wt-1',
      launchSource: 'sidebar'
    })
    expect(toast.success.mock.calls[0][1]).toBeUndefined()
  })

  it('does not show a success action when the launch fails after a synchronous callback', async () => {
    launchAgentInNewTab.mockImplementation((args) => {
      args.onPromptDelivered()
      return null
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue',
        worktreeId: 'wt-1',
        launchSource: 'sidebar'
      })
    ).resolves.toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it('does not report success or throw from a queued delivery when the launcher throws', async () => {
    const queued: (() => void)[] = []
    vi.stubGlobal('queueMicrotask', (callback: () => void) => queued.push(callback))
    launchAgentInNewTab.mockImplementation((args) => {
      args.onPromptDelivered()
      throw new Error('launch failed after delivery callback')
    })
    const { launchAgentSessionContinuation } = await import('./launch-agent-session-continuation')
    await expect(
      launchAgentSessionContinuation({
        agent: 'claude',
        prompt: 'continue',
        worktreeId: 'wt-1',
        launchSource: 'sidebar'
      })
    ).rejects.toThrow('launch failed after delivery callback')
    expect(queued).toHaveLength(1)
    expect(() => queued[0]()).not.toThrow()
    expect(toast.success).not.toHaveBeenCalled()
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
        launchSource: 'sidebar'
      })
    ).resolves.toBe(false)

    expect(launchAgentInNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Codex was not detected on this workspace host.')
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
      launchSource: 'sidebar'
    })

    expect(launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', promptDelivery: 'submit-after-ready' })
    )
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The new Codex session started, but its context could not be sent.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Copy prompt' }) })
      )
    )
  })

  it('hedges instead of claiming success when the paste went out unconfirmed', async () => {
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
      agent: 'codex',
      prompt: 'continue the unfinished task',
      worktreeId: 'wt-1',
      launchSource: 'sidebar'
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(
      'Orca could not confirm Codex received the session context. Check the new session, and paste it yourself if its input is empty.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Copy prompt' }) })
    )
    toast.warning.mock.calls[0][1].action.onClick()
    expect(writeClipboardText).toHaveBeenCalledWith('continue the unfinished task')
  })

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
      launchSource: 'sidebar'
    })

    expect(toast.success).toHaveBeenCalledWith(
      'Session context sent to Codex in a new session.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open session' }) })
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
