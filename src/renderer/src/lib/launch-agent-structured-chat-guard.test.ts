// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockCreateUnifiedTab = vi.fn<
  (
    worktreeId: string,
    contentType: string,
    init: {
      id: string
      entityId: string
      targetGroupId?: string
      agentSessionAgent?: string
      label?: string
    }
  ) => {
    id: string
    entityId: string
    contentType: string
    worktreeId: string
    groupId: string
    agentSessionAgent?: string
    label?: string
  }
>()
const mockSetTabViewMode = vi.fn()
const mockWaitForAgentReady = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockMarkNativeChatLaunchPromptFailed = vi.fn()
const mockCreateStructuredCodexSessionLaunchIntent = vi.fn()
const mockAbandonStructuredAgentSessionLaunchIntent = vi.fn()
const mockRetryStructuredAgentSessionLaunchIntent =
  vi.fn<
    (intent: ReturnType<typeof structuredLaunchIntent>) => ReturnType<typeof structuredLaunchIntent>
  >()
const mockLaunchStructuredCodexSession = vi.fn()
const mockRefreshLocalStructuredSessionTabs = vi.fn()
const mockToastError = vi.fn()
const mockCallStructuredAgentSession = vi.fn()
const STRUCTURED_HOST_CAPABILITIES = ['agent-session.structured.v1']
let hostCapabilities: readonly string[] | null = STRUCTURED_HOST_CAPABILITIES

type UnifiedTabFixture = {
  id: string
  contentType: string
  entityId: string
  worktreeId: string
  groupId: string
  agentSessionAgent?: string
  label?: string
}
const emptyUnifiedTabsByWorktree: Record<string, UnifiedTabFixture[]> = {}

function structuredLaunchIntent(worktreeId: string, sessionId = 'codex-session-1') {
  return {
    sessionId,
    worktreeId,
    target: { kind: 'local' as const },
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: 'f'.repeat(64)
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex' as const
    }
  }
}

const store = {
  clearNativeChatLaunchDraft: vi.fn(),
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    experimentalNativeChat: true,
    experimentalStructuredNativeChat: true,
    openAgentTabsInChatByDefault: true,
    nativeChatSessionOptions: undefined as
      | Record<
          string,
          { model?: string; valuesByModel?: Record<string, Record<string, string | boolean>> }
        >
      | undefined
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map(),
  transientClearedAgentStatusConnectionIds: {},
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', projectId: 'repo-1', path: '/repo/worktree' }]
  },
  detectedWorktreesByRepo: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  unifiedTabsByWorktree: emptyUnifiedTabsByWorktree,
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  createTab: mockCreateTab,
  createUnifiedTab: mockCreateUnifiedTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
  focusGroup: vi.fn(),
  activateTab: vi.fn(),
  setTabViewMode: mockSetTabViewMode,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: mockToastError } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-ready-wait', () => ({ waitForAgentReady: mockWaitForAgentReady }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))
vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mockCreateStructuredCodexSessionLaunchIntent,
    abandonStructuredAgentSessionLaunchIntent: mockAbandonStructuredAgentSessionLaunchIntent,
    retryStructuredAgentSessionLaunchIntent: mockRetryStructuredAgentSessionLaunchIntent,
    launchStructuredAgentSession: mockLaunchStructuredCodexSession,
    StructuredAgentSessionCreateRefusalError
  }
})
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs,
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => hostCapabilities
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () =>
    store.repos[0]?.connectionId ? `ssh:${store.repos[0].connectionId}` : 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mockCallStructuredAgentSession
}))

/** Structured adoption creates the tab in terminal mode and flips it to chat once
 *  Codex is ready; the bridge stamps `viewMode: 'chat'` on the tab up front. That
 *  difference is the only observable signal that the availability guard ran. */
describe('structured chat adoption guard on the launch path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'structured-agent-session-codex-session-1',
          contentType: 'agent-session',
          entityId: 'codex-session-1',
          worktreeId: 'wt-1',
          groupId: 'group-1'
        }
      ]
    }
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.projects = [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }]
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockCreateUnifiedTab.mockImplementation((worktreeId, contentType, init) => {
      const tab = {
        id: init.id,
        entityId: init.entityId,
        contentType,
        worktreeId,
        groupId: init.targetGroupId ?? 'group-1',
        ...(init.agentSessionAgent ? { agentSessionAgent: init.agentSessionAgent } : {}),
        ...(init.label ? { label: init.label } : {})
      }
      store.unifiedTabsByWorktree[worktreeId] = [
        ...(store.unifiedTabsByWorktree[worktreeId] ?? []),
        tab
      ]
      return tab
    })
    mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    mockCreateStructuredCodexSessionLaunchIntent.mockImplementation((worktreeId: string) =>
      structuredLaunchIntent(worktreeId)
    )
    mockRetryStructuredAgentSessionLaunchIntent.mockImplementation((intent) => ({
      ...intent,
      params: {
        ...intent.params,
        envelope: {
          ...intent.params.envelope,
          clientOperationId: `${intent.params.envelope.clientOperationId}-retry`
        }
      }
    }))
    mockLaunchStructuredCodexSession.mockResolvedValue({
      sessionId: 'codex-session-1',
      fence: 1
    })
    mockCallStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 },
      value: { submission: { dispatchState: 'accepted' } }
    })
    mockRefreshLocalStructuredSessionTabs.mockResolvedValue([
      {
        worktree: 'wt-1',
        tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }]
      }
    ])
    mockToastError.mockReset()
    hostCapabilities = STRUCTURED_HOST_CAPABILITIES
    store.settings.openAgentTabsInChatByDefault = true
    store.settings.nativeChatSessionOptions = undefined
  })

  afterEach(async () => {
    const { cancelStructuredAgentLaunch, retireStructuredAgentSessionLaunchCancellationTombstone } =
      await import('./structured-agent-session-launch')
    for (const sessionId of ['codex-session-1', 'codex-session-2']) {
      cancelStructuredAgentLaunch('wt-1', sessionId)
      retireStructuredAgentSessionLaunchCancellationTombstone('wt-1', sessionId)
    }
  })

  it('takes the structured path when the chat-default view is selected', async () => {
    const { launchAgentInNewTab, shouldQueueTerminalFocusAfterMenuClose } =
      await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      surface: {
        kind: 'local-agent-session',
        tabId: 'structured-agent-session-codex-session-1',
        sessionId: 'codex-session-1'
      },
      pasteDraftAfterLaunch: false
    })
    expect(shouldQueueTerminalFocusAfterMenuClose(result!)).toBe(false)
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'codex-session-1'
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith('wt-1', 'codex')
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1' })
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  // Routing only: the host seeds the saved values, so preservation is pinned there.
  it('takes the structured path when a Codex model and effort are already saved', async () => {
    store.settings.nativeChatSessionOptions = {
      codex: {
        model: 'gpt-5.6-sol',
        valuesByModel: { 'gpt-5.6-sol': { effort: 'medium' } }
      }
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      surface: { kind: 'local-agent-session', sessionId: 'codex-session-1' }
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith('wt-1', 'codex')
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('takes the structured path for Claude, naming Claude as the create provider', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      surface: { kind: 'local-agent-session', sessionId: 'codex-session-1' }
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith('wt-1', 'claude')
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('keeps a native-chat agent with no structured adapter on the terminal-backed path', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'openclaude', worktreeId: 'wt-1' })

    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalled()
  })

  it('keeps a declined Claude launch on the structured path', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    const refusal = new StructuredAgentSessionCreateRefusalError(
      'structured_agent_session_unsupported'
    )
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(refusal)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      surface: { kind: 'local-agent-session', sessionId: 'codex-session-1' }
    })
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'failed',
      error: refusal
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledOnce())
  })

  it.each([[], null])(
    'preserves terminal-backed launches with capability answer %s',
    async (capabilities) => {
      hostCapabilities = capabilities
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })
      launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

      expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
      expect(mockCreateTab).toHaveBeenCalledTimes(2)
    }
  )

  /** The toggle is hidden under Terminal chat but its persisted value survives, so the launch
   *  path must re-check the default view rather than trust a stale opt-in. */
  it('ignores a stale structured opt-in while the default view is Terminal chat', async () => {
    store.settings.openAgentTabsInChatByDefault = false
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result?.surface).toEqual({ kind: 'local-terminal', tabId: 'tab-1' })
    expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
  })

  it('does not open a terminal on a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    const refusal = new StructuredAgentSessionCreateRefusalError('provider unavailable')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(refusal)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      surface: { kind: 'local-agent-session', sessionId: 'codex-session-1' },
      pasteDraftAfterLaunch: false
    })
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'failed',
      error: refusal
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledOnce())
  })

  it('reports no prompt delivery from a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(
      new StructuredAgentSessionCreateRefusalError('provider unavailable')
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    await expect(result?.structuredSettlement).resolves.toMatchObject({
      kind: 'failed'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('coalesces repeated structured launches for one worktree while the host is starting', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mockLaunchStructuredCodexSession.mockImplementationOnce(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => (resolveLaunch = resolve))
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const first = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    const second = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(first).toMatchObject({ surface: { kind: 'local-agent-session' } })
    expect(second).toMatchObject({ surface: { kind: 'local-agent-session' } })
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(1)
    resolveLaunch({ sessionId: 'codex-session-1', fence: 1 })
  })

  it('keeps the single-flight reservation until the published tab inventory is refreshed', async () => {
    store.unifiedTabsByWorktree = {}
    let resolveRefresh!: (snapshots: unknown[]) => void
    mockRefreshLocalStructuredSessionTabs.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => (resolveRefresh = resolve))
    )
    mockLaunchStructuredCodexSession.mockResolvedValue({
      sessionId: 'codex-session-1',
      fence: 1
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(1))

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(1)
    store.unifiedTabsByWorktree['wt-1'] = [
      {
        id: 'structured-agent-session-codex-session-1',
        contentType: 'agent-session',
        entityId: 'codex-session-1',
        worktreeId: 'wt-1',
        groupId: 'group-1'
      }
    ]
    resolveRefresh([
      { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }] }
    ])
    await vi.waitFor(() => expect(mockToastError).not.toHaveBeenCalled())
  })

  it('does not create a sibling when post-create visibility proof is unknown', async () => {
    store.unifiedTabsByWorktree = {}
    const firstIntent = structuredLaunchIntent('wt-1', 'codex-session-1')
    const secondIntent = structuredLaunchIntent('wt-1', 'codex-session-2')
    mockCreateStructuredCodexSessionLaunchIntent
      .mockReturnValueOnce(firstIntent)
      .mockReturnValueOnce(secondIntent)
    mockLaunchStructuredCodexSession
      .mockResolvedValueOnce({ sessionId: firstIntent.sessionId, fence: 1 })
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ sessionId: secondIntent.sessionId, fence: 1 })
    mockRefreshLocalStructuredSessionTabs
      .mockRejectedValueOnce(new Error('inventory unavailable'))
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => {
        // The inventory refresh also publishes the host snapshot into the renderer projection.
        store.unifiedTabsByWorktree['wt-1'] = [
          {
            id: `structured-agent-session-${firstIntent.sessionId}`,
            contentType: 'agent-session',
            entityId: firstIntent.sessionId,
            worktreeId: 'wt-1',
            groupId: 'group-1'
          }
        ]
        return Promise.resolve([
          { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: firstIntent.sessionId }] }
        ])
      })
      .mockResolvedValueOnce([
        { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: 'codex-session-2' }] }
      ])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const unknown = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    await expect(unknown?.structuredSettlement).resolves.toEqual({
      kind: 'visibility-unknown',
      sessionId: firstIntent.sessionId
    })
    expect(mockCreateTab).not.toHaveBeenCalled()

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(3))

    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(1)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession.mock.calls[0]?.[0]).toBe(firstIntent)
    expect(mockLaunchStructuredCodexSession.mock.calls[1]?.[0]).toBe(firstIntent)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A successful retry must release the reservation so a later launch can start normally.
    store.unifiedTabsByWorktree['wt-1'] = [
      {
        id: `structured-agent-session-${secondIntent.sessionId}`,
        contentType: 'agent-session',
        entityId: secondIntent.sessionId,
        worktreeId: 'wt-1',
        groupId: 'group-1'
      }
    ]
    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(3))
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(3)
    expect(mockLaunchStructuredCodexSession.mock.calls[2]?.[0]).toBe(secondIntent)
  })

  it('routes an auto-submitted Codex prompt through the structured outbox', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task'
    })

    expect(result).toMatchObject({
      surface: { kind: 'local-agent-session', sessionId: 'codex-session-1' }
    })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('leaves a refused structured prompt queued for an explicit retry', async () => {
    mockCallStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_busy', message: 'busy' }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('keeps an SSH Codex tab on the bridge', async () => {
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it('keeps a runtime-paired Codex tab on the bridge', async () => {
    store.repos = [{ id: 'repo-1', connectionId: 'runtime-ssh-a', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })
})
