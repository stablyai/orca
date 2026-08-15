import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLaunchAgentBackgroundSession = vi.fn()
const mockLaunchWorktreeBackgroundTerminals = vi.fn()
const mockSubmitPromptToAgentPty = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockCreateWorktree = vi.fn()
const mockMarkDispatchResult = vi.fn()
const mockOnDispatchRequested = vi.fn()
const mockRendererReady = vi.fn()
const mockFinalizeTerminalOwnership = vi.fn()
const mockReleaseTerminalOwnership = vi.fn()
const mockSshNeedsPassphrasePrompt = vi.fn()
const mockSshGetState = vi.fn()
const mockSshConnect = vi.fn()
const agentStatusListeners = new Set<() => void>()
let latestStoreSubscriber: (() => void) | null = null
const mockStoreSubscribe = vi.fn((listener: () => void) => {
  latestStoreSubscriber = listener
  agentStatusListeners.add(listener)
  return () => {
    agentStatusListeners.delete(listener)
  }
})

const setupLaunch = {
  runnerScriptPath: '/tmp/setup.sh',
  envVars: { ORCA_WORKTREE_PATH: '/repo/worktree' }
}

const createdWorktree = {
  id: 'wt-created',
  repoId: 'repo-1',
  displayName: 'Automation worktree',
  path: '/repo/worktree'
}
type TestWorktree = typeof createdWorktree
type TestRepo = {
  id: string
  connectionId: string | null
  executionHostId: string | null
  path: string
}

const state = {
  activeView: 'terminal' as const,
  activeWorktreeId: 'wt-active',
  activeTabId: 'tab-active',
  activeTabType: 'terminal' as const,
  repos: [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }] as TestRepo[],
  folderWorkspaces: [] as {
    id: string
    projectGroupId: string
    folderPath: string
    connectionId: string | null
  }[],
  projectGroups: [] as {
    id: string
    connectionId: string | null
    executionHostId?: string | null
  }[],
  worktreesByRepo: {} as Record<string, TestWorktree[]>,
  detectedWorktreesByRepo: {},
  agentStatusByPaneKey: {},
  allWorktrees: vi.fn<() => TestWorktree[]>(() => []),
  getKnownWorktreeById: vi.fn<(worktreeId: string) => TestWorktree | undefined>(() => undefined),
  createWorktree: mockCreateWorktree,
  subscribe: vi.fn(() => () => {}),
  setActiveView: vi.fn(),
  setActiveWorktree: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn()
}

function makeAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'automation-1',
    projectId: 'repo-1',
    prompt: 'run this',
    precheck: null,
    agentId: 'claude',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    setupDecision: 'run',
    reuseSession: false,
    ...overrides
  }
}

function makeRun() {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Nightly setup run',
    scheduledFor: Date.parse('2026-06-24T03:00:00Z'),
    trigger: 'scheduled',
    workspaceId: null,
    workspaceDisplayName: null
  }
}

async function registerAndDispatch(automation = makeAutomation()): Promise<void> {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })
  const { useAutomationDispatchEvents: registerAutomationDispatchEvents } =
    await import('./useAutomationDispatchEvents')
  registerAutomationDispatchEvents()
  const handler = mockOnDispatchRequested.mock.calls[0]?.[0]
  if (!handler) {
    throw new Error('dispatch handler was not registered')
  }
  await handler({
    automation,
    run: makeRun(),
    dispatchToken: 'dispatch-token'
  })
}

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))

vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: mockLaunchWorktreeBackgroundTerminals
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  submitPromptToAgentPty: mockSubmitPromptToAgentPty
}))

vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mockFindReusableAutomationSession
}))

vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mockObserveExistingAutomationSession
}))

vi.mock('@/components/automations/automation-run-output-snapshot', () => ({
  createAutomationRunOutputSnapshotBuffer: () => ({
    append: vi.fn(),
    snapshot: () => null
  }),
  selectAutomationRunOutputSnapshot: (
    assistantMessage: string | null | undefined,
    terminalSnapshot: unknown
  ) =>
    assistantMessage
      ? {
          format: 'plain_text',
          content: assistantMessage,
          capturedAt: 1,
          truncated: false
        }
      : terminalSnapshot
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'create-request-id'
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: mockStoreSubscribe
  }
}))

const AUTOMATION_PANE_KEY = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'

function publishAgentStatus(
  entry: {
    state: 'working' | 'blocked' | 'waiting' | 'done'
    updatedAt?: number
    lastAssistantMessage?: string
    providerSession?: { key: 'session_id' | 'conversation_id'; id: string }
  },
  paneKey = AUTOMATION_PANE_KEY
): void {
  state.agentStatusByPaneKey = {
    ...state.agentStatusByPaneKey,
    [paneKey]: {
      state: entry.state,
      prompt: '',
      updatedAt: entry.updatedAt ?? Date.now(),
      stateStartedAt: entry.updatedAt ?? Date.now(),
      paneKey,
      stateHistory: [],
      ...(entry.lastAssistantMessage ? { lastAssistantMessage: entry.lastAssistantMessage } : {}),
      ...(entry.providerSession ? { providerSession: entry.providerSession } : {})
    }
  }
  for (const listener of agentStatusListeners) {
    listener()
  }
}

describe('useAutomationDispatchEvents completion', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    agentStatusListeners.clear()
    // Why: leftover pane status can pass the startedAfter filter on the same ms and flake.
    state.agentStatusByPaneKey = {}
    state.activeView = 'terminal'
    state.activeWorktreeId = 'wt-active'
    state.activeTabId = 'tab-active'
    state.activeTabType = 'terminal'
    state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }]
    state.folderWorkspaces = []
    state.projectGroups = []
    state.worktreesByRepo = {}
    latestStoreSubscriber = null
    state.allWorktrees.mockReturnValue([])
    state.getKnownWorktreeById.mockReturnValue(undefined)
    mockCreateWorktree.mockResolvedValue({ worktree: createdWorktree, setup: setupLaunch })
    mockLaunchWorktreeBackgroundTerminals.mockResolvedValue(undefined)
    mockLaunchAgentBackgroundSession.mockResolvedValue({
      tabId: 'agent-tab',
      paneKey: AUTOMATION_PANE_KEY,
      ptyId: 'agent-pty',
      startupPlan: {},
      terminalOwnership: {
        finalize: mockFinalizeTerminalOwnership,
        release: mockReleaseTerminalOwnership
      }
    })
    mockOnDispatchRequested.mockReturnValue(() => {})
    mockSshNeedsPassphrasePrompt.mockResolvedValue(false)
    mockSshGetState.mockResolvedValue({ status: 'connected' })
    mockSshConnect.mockResolvedValue({ status: 'connected' })
    mockSubmitPromptToAgentPty.mockResolvedValue(true)
    vi.stubGlobal('window', {
      api: {
        automations: {
          onDispatchRequested: mockOnDispatchRequested,
          rendererReady: mockRendererReady,
          markDispatchResult: mockMarkDispatchResult,
          runPrecheck: vi.fn(),
          listRuns: vi.fn().mockResolvedValue([])
        },
        ssh: {
          needsPassphrasePrompt: mockSshNeedsPassphrasePrompt,
          getState: mockSshGetState,
          connect: mockSshConnect
        }
      },
      dispatchEvent: vi.fn()
    })
  })

  it('ignores a session-boundary done so a connecting agent cannot complete the run (STA-3386)', async () => {
    let launchArgs: {
      onAgentStatus?: (payload: { state: string; sessionBoundary?: boolean }) => void
    } = {}
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()
    // Why: Claude fires SessionStart (a sessionBoundary done) at launch, before the argv
    // prompt submits — treating it as run completion would close the tab on an empty run.
    launchArgs.onAgentStatus?.({ state: 'done', sessionBoundary: true })
    await Promise.resolve()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()

    launchArgs.onAgentStatus?.({ state: 'done' })
    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())
  })

  it('persists assistant output from a batched working→done→working transition', async () => {
    const paneKey = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'

    await registerAndDispatch()
    const transitionStartedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [paneKey]: {
        paneKey,
        state: 'working',
        prompt: 'second turn',
        agentType: 'claude',
        updatedAt: transitionStartedAt + 2,
        stateStartedAt: transitionStartedAt + 2,
        lastCompletedAssistantMessage: 'Summary.\n\nDetails.',
        stateHistory: [
          { state: 'working', prompt: 'first turn', startedAt: transitionStartedAt },
          { state: 'done', prompt: 'first turn', startedAt: transitionStartedAt + 1 }
        ]
      }
    }
    if (!latestStoreSubscriber) {
      throw new Error('agent status observer was not registered')
    }
    latestStoreSubscriber()

    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'completed',
        outputSnapshot: {
          format: 'plain_text',
          content: 'Summary.\n\nDetails.',
          capturedAt: 1,
          truncated: false
        }
      })
    )
  })

  it('does not let later working authorize an earlier historical done on rescan', async () => {
    const paneKey = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'agent-tab',
      paneKey,
      ptyId: 'agent-pty'
    })
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})

    await registerAndDispatch(makeAutomation({ reuseSession: true }))
    const transitionStartedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [paneKey]: {
        paneKey,
        state: 'working',
        prompt: 'new turn',
        agentType: 'claude',
        updatedAt: transitionStartedAt + 1,
        stateStartedAt: transitionStartedAt + 1,
        stateHistory: [{ state: 'done', prompt: 'old turn', startedAt: transitionStartedAt }]
      }
    }
    if (!latestStoreSubscriber) {
      throw new Error('agent status observer was not registered')
    }

    latestStoreSubscriber()
    latestStoreSubscriber()
    await Promise.resolve()

    expect(mockMarkDispatchResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
  })

  // Why: transport loss, PTY exit and cap eviction all drop and recreate the live
  // entry with an empty stateHistory. The working edge is only in the observer's
  // own bookkeeping by then, so it must survive a zero-overlap rescan.
  it('completes a reuse-session run when the entry is recreated with no history', async () => {
    const paneKey = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'agent-tab',
      paneKey,
      ptyId: 'agent-pty'
    })
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})

    await registerAndDispatch(makeAutomation({ reuseSession: true }))
    const workingStartedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [paneKey]: {
        paneKey,
        state: 'working',
        prompt: 'turn',
        agentType: 'claude',
        updatedAt: workingStartedAt,
        stateStartedAt: workingStartedAt,
        stateHistory: [{ state: 'working', prompt: 'turn', startedAt: workingStartedAt }]
      }
    }
    if (!latestStoreSubscriber) {
      throw new Error('agent status observer was not registered')
    }
    latestStoreSubscriber()
    await Promise.resolve()

    // The entry is dropped and recreated: same pane, now done, history gone.
    state.agentStatusByPaneKey = {
      [paneKey]: {
        paneKey,
        state: 'done',
        prompt: 'turn',
        agentType: 'claude',
        updatedAt: workingStartedAt + 2,
        stateStartedAt: workingStartedAt + 2,
        stateHistory: []
      }
    }
    latestStoreSubscriber()
    await Promise.resolve()

    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
  })

  it('does not label a PTY exit as exact after only a working bind', async () => {
    let launchArgs: {
      onExit?: (ptyId: string, code: number) => void
    } = {}
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: AUTOMATION_PANE_KEY,
        ptyId: 'agent-pty',
        startupPlan: {},
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()
    publishAgentStatus({
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary-session' }
    })
    launchArgs.onExit?.('agent-pty', 0)

    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          completionAttribution: expect.objectContaining({
            kind: 'pane_time_fallback',
            providerSessionId: null
          })
        })
      )
    )
  })

  it('does not bind a live provider session from historical working samples', async () => {
    const paneKey = AUTOMATION_PANE_KEY
    await registerAndDispatch()
    const startedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [paneKey]: {
        paneKey,
        state: 'working',
        prompt: 'second turn',
        agentType: 'claude',
        updatedAt: startedAt + 2,
        stateStartedAt: startedAt + 2,
        lastCompletedAssistantMessage: 'stale nested digest',
        providerSession: { key: 'session_id', id: 'nested-session' },
        stateHistory: [
          { state: 'working', prompt: 'first turn', startedAt },
          { state: 'done', prompt: 'first turn', startedAt: startedAt + 1 }
        ]
      }
    }
    if (!latestStoreSubscriber) {
      throw new Error('agent status observer was not registered')
    }
    latestStoreSubscriber()
    await Promise.resolve()

    // History has no providerSession; replaying it with the live nested session
    // must not finalize as if that nested session already completed.
    expect(
      mockMarkDispatchResult.mock.calls.some(([result]) => result.status === 'completed')
    ).toBe(false)
  })

  it('consumes duplicate done and zero-exit completion through one finalizer', async () => {
    let launchArgs: {
      onAgentStatus?: (payload: { state: string }) => void
      onExit?: (ptyId: string, code: number) => void
    } = {}
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()
    launchArgs.onAgentStatus?.({ state: 'done' })
    launchArgs.onExit?.('agent-pty', 0)
    launchArgs.onAgentStatus?.({ state: 'done' })
    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())

    expect(
      mockMarkDispatchResult.mock.calls.filter(
        ([result]) => result.status === 'completed' && result.terminalPaneKey !== null
      )
    ).toHaveLength(1)
    expect(mockReleaseTerminalOwnership).not.toHaveBeenCalled()
  })

  it('releases ownership on nonzero exit without finalizing the tab', async () => {
    let onExit: ((ptyId: string, code: number) => void) | undefined
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      onExit = args.onExit
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()
    onExit?.('agent-pty', 9)
    await vi.waitFor(() => expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('releases ownership when dispatched result persistence rejects', async () => {
    mockMarkDispatchResult.mockRejectedValueOnce(new Error('persistence unavailable'))

    await registerAndDispatch()

    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('releases ownership when completed result persistence rejects', async () => {
    mockMarkDispatchResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('completion persistence unavailable'))
      .mockResolvedValueOnce(undefined)
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      args.onAgentStatus?.({ state: 'done' })
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()

    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('diagnoses a late completed-persistence rejection once without terminal cleanup', async () => {
    let onAgentStatus: ((payload: { state: string }) => void) | undefined
    const persistenceError = new Error('late completion persistence unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockMarkDispatchResult.mockResolvedValueOnce(undefined).mockRejectedValueOnce(persistenceError)
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      onAgentStatus = args.onAgentStatus
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()
    onAgentStatus?.({ state: 'done' })
    onAgentStatus?.({ state: 'done' })
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledOnce())

    expect(errorSpy).toHaveBeenCalledWith(
      '[automations] Failed to persist late automation result:',
      persistenceError
    )
    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(
      mockMarkDispatchResult.mock.calls.filter(
        ([result]) => result.status === 'completed' && result.terminalPaneKey !== null
      )
    ).toHaveLength(1)
    errorSpy.mockRestore()
  })

  it('preserves a fresh reuse-enabled session as the future reuse seed', async () => {
    mockFindReusableAutomationSession.mockReturnValue(null)

    await registerAndDispatch(makeAutomation({ reuseSession: true }))

    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
  })

  it('does not finalize when a nested same-pane session reports done', async () => {
    await registerAndDispatch()

    publishAgentStatus({
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary-session' },
      lastAssistantMessage: 'primary working'
    })
    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'nested-session' },
      lastAssistantMessage: 'nested SessionStart output'
    })

    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'dispatched' })
      )
    )
    expect(
      mockMarkDispatchResult.mock.calls.some(([result]) => result.status === 'completed')
    ).toBe(false)
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
  })

  it('ignores nested done that arrives before any working bind', async () => {
    await registerAndDispatch()

    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'nested-session' },
      lastAssistantMessage: 'nested SessionStart output'
    })

    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'dispatched' })
      )
    )
    expect(
      mockMarkDispatchResult.mock.calls.some(([result]) => result.status === 'completed')
    ).toBe(false)
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()

    publishAgentStatus({
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary-session' }
    })
    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'primary-session' },
      lastAssistantMessage: 'primary digest'
    })

    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())
  })

  it('finalizes when the bound primary session reports done after nested noise', async () => {
    await registerAndDispatch()

    publishAgentStatus({
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary-session' }
    })
    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'nested-session' },
      lastAssistantMessage: 'nested SessionStart output'
    })
    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'primary-session' },
      lastAssistantMessage: 'primary digest'
    })

    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())
    expect(
      mockMarkDispatchResult.mock.calls.some(
        ([result]) =>
          result.status === 'completed' &&
          result.outputSnapshot !== undefined &&
          result.completionAttribution?.kind === 'exact_provider_session' &&
          result.completionAttribution.providerSessionId === 'primary-session' &&
          result.completionAttribution.provider === 'claude'
      )
    ).toBe(true)
  })

  it('attributes reuse-session completion by primary provider session', async () => {
    const existingWorktree = {
      id: 'wt-existing',
      repoId: 'repo-1',
      displayName: 'Existing workspace',
      path: '/repo/existing'
    }
    state.allWorktrees.mockReturnValue([existingWorktree])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reuse-tab',
      paneKey: AUTOMATION_PANE_KEY,
      ptyId: 'reuse-pty'
    })
    mockSubmitPromptToAgentPty.mockResolvedValue(true)
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})

    await registerAndDispatch(
      makeAutomation({
        reuseSession: true,
        workspaceMode: 'existing',
        workspaceId: existingWorktree.id
      })
    )

    expect(mockSubmitPromptToAgentPty).toHaveBeenCalled()
    expect(mockObserveExistingAutomationSession).toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()

    publishAgentStatus({
      state: 'working',
      providerSession: { key: 'session_id', id: 'reuse-primary' }
    })
    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'reuse-nested' },
      lastAssistantMessage: 'nested should not win'
    })
    await Promise.resolve()
    expect(
      mockMarkDispatchResult.mock.calls.some(([result]) => result.status === 'completed')
    ).toBe(false)

    publishAgentStatus({
      state: 'done',
      providerSession: { key: 'session_id', id: 'reuse-primary' },
      lastAssistantMessage: 'reuse primary done'
    })
    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      )
    )
  })
})
