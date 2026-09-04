// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockSetTabViewMode = vi.fn()
const mockWaitForAgentReady = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockMarkNativeChatLaunchPromptFailed = vi.fn()
const mockCreateStructuredCodexSessionLaunchIntent = vi.fn()
const mockAbandonStructuredAgentSessionLaunchIntent = vi.fn()
const mockLaunchStructuredCodexSession = vi.fn()
const mockRefreshLocalStructuredSessionTabs = vi.fn()
const mockToastError = vi.fn()
const mockCallStructuredAgentSession = vi.fn()

function structuredLaunchIntent(worktreeId: string, sessionId = 'codex-session-1') {
  return {
    sessionId,
    worktreeId,
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
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    experimentalNativeChat: true,
    experimentalStructuredNativeChat: true,
    openAgentTabsInChatByDefault: true
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
  unifiedTabsByWorktree: {} as Record<
    string,
    { contentType: string; entityId: string; worktreeId: string }[]
  >,
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
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
vi.mock('@/lib/launch-structured-codex-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredCodexSessionLaunchIntent: mockCreateStructuredCodexSessionLaunchIntent,
    abandonStructuredAgentSessionLaunchIntent: mockAbandonStructuredAgentSessionLaunchIntent,
    launchStructuredCodexSession: mockLaunchStructuredCodexSession,
    StructuredAgentSessionCreateRefusalError
  }
})
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs,
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilities: () => ['agent-session.structured.v1']
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
      'wt-1': [{ contentType: 'agent-session', entityId: 'codex-session-1', worktreeId: 'wt-1' }]
    }
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.projects = [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }]
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    mockCreateStructuredCodexSessionLaunchIntent.mockImplementation((worktreeId: string) =>
      structuredLaunchIntent(worktreeId)
    )
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
    store.settings.openAgentTabsInChatByDefault = true
  })

  it('takes the structured path when the chat-default view is selected', async () => {
    const { launchAgentInNewTab, shouldQueueTerminalFocusAfterMenuClose } =
      await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      tabId: null,
      pasteDraftAfterLaunch: false,
      focusAfterMenuClose: 'structured-session'
    })
    expect(shouldQueueTerminalFocusAfterMenuClose(result!)).toBe(false)
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith('wt-1')
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1' })
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  /** The toggle is hidden under Terminal chat but its persisted value survives, so the launch
   *  path must re-check the default view rather than trust a stale opt-in. */
  it('ignores a stale structured opt-in while the default view is Terminal chat', async () => {
    store.settings.openAgentTabsInChatByDefault = false
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result?.tabId).toBe('tab-1')
    expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
  })

  it('falls back to the preserved terminal launch on a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-codex-session')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(
      new StructuredAgentSessionCreateRefusalError('provider unavailable')
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({ tabId: null, pasteDraftAfterLaunch: false })
    await vi.waitFor(() => expect(mockCreateTab).toHaveBeenCalledOnce())
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('reports prompt delivery from the definitive-refusal terminal fallback', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-codex-session')
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
      delivered: true,
      failureNotified: false
    })
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledOnce()
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

    expect(first).toMatchObject({ focusAfterMenuClose: 'structured-session' })
    expect(second).toMatchObject({ focusAfterMenuClose: 'structured-session' })
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
      { contentType: 'agent-session', entityId: 'codex-session-1', worktreeId: 'wt-1' }
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
          { contentType: 'agent-session', entityId: firstIntent.sessionId, worktreeId: 'wt-1' }
        ]
        return Promise.resolve([
          { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: firstIntent.sessionId }] }
        ])
      })
      .mockResolvedValueOnce([
        { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: 'codex-session-2' }] }
      ])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(3))

    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(1)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession.mock.calls[0]?.[0]).toBe(firstIntent)
    expect(mockLaunchStructuredCodexSession.mock.calls[1]?.[0]).toBe(firstIntent)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A successful retry must release the reservation so a later launch can start normally.
    store.unifiedTabsByWorktree['wt-1'] = [
      { contentType: 'agent-session', entityId: secondIntent.sessionId, worktreeId: 'wt-1' }
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

    expect(result).toMatchObject({ tabId: null, focusAfterMenuClose: 'structured-session' })
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
