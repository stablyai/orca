// Session-lifecycle half of the dispatch suite: completion detection, terminal
// ownership, and retired-terminal cleanup. Workspace resolution and setup launch
// live in useAutomationDispatchEvents.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  automationRunOutputSnapshotMock,
  getLatestStoreSubscriber,
  makeAutomation,
  mockFinalizeTerminalOwnership,
  mockFindReusableAutomationSession,
  mockLaunchAgentBackgroundSession,
  mockLaunchWorktreeBackgroundTerminals,
  mockMarkDispatchResult,
  mockObserveExistingAutomationSession,
  mockReleaseTerminalOwnership,
  mockStoreSubscribe,
  mockSubmitPromptToAgentPty,
  registerAndDispatch,
  resetAutomationDispatchHarness,
  state
} from './automation-dispatch-events-test-harness'

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

vi.mock(
  '@/components/automations/automation-run-output-snapshot',
  () => automationRunOutputSnapshotMock
)

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

const AGENT_PANE_KEY = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'

function requireStoreSubscriber(): () => void {
  const subscriber = getLatestStoreSubscriber()
  if (!subscriber) {
    throw new Error('agent status observer was not registered')
  }
  return subscriber
}

describe('useAutomationDispatchEvents session lifecycle', () => {
  beforeEach(() => {
    resetAutomationDispatchHarness()
  })

  it('finalizes a fresh non-reuse terminal only after completed result persistence', async () => {
    const order: string[] = []
    let launchArgs: { onAgentStatus?: (payload: { state: string }) => void } = {}
    mockMarkDispatchResult.mockImplementation(
      async (result: { status: string; terminalPaneKey?: string | null }) => {
        // The retirement clear reuses status 'completed' but nulls the terminal
        // identity; label it distinctly so ordering stays legible.
        order.push(
          result.status === 'completed' && result.terminalPaneKey === null
            ? 'clear-terminal-identity'
            : `persist:${result.status}`
        )
      }
    )
    mockFinalizeTerminalOwnership.mockImplementation(() => {
      order.push('finalize')
      return true
    })
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: AGENT_PANE_KEY,
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
    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())

    expect(order).toEqual([
      'persist:dispatched',
      'persist:completed',
      'finalize',
      'clear-terminal-identity'
    ])
    expect(mockReleaseTerminalOwnership).not.toHaveBeenCalled()
    // Why: the retired terminal is gone; the run must drop its pane/pty pointers
    // so "View run" resolves to the workspace/snapshot, not an unavailable terminal.
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith({
      runId: expect.any(String),
      status: 'completed',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    })
  })

  // Why: the host applies this second update to an ALREADY-final run, so the
  // cleanup must carry every pointer as an explicit null — an omitted key is
  // preserved by the store and would leave "View run" on a dead terminal.
  it('clears every terminal pointer explicitly after the terminal is retired', async () => {
    mockFinalizeTerminalOwnership.mockReturnValue(true)
    let launchArgs: { onAgentStatus?: (payload: { state: string }) => void } = {}
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: AGENT_PANE_KEY,
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
    await vi.waitFor(() => expect(mockFinalizeTerminalOwnership).toHaveBeenCalledOnce())

    const cleanup = mockMarkDispatchResult.mock.calls.at(-1)?.[0]
    for (const key of ['terminalSessionId', 'terminalPaneKey', 'terminalPtyId'] as const) {
      expect(Object.hasOwn(cleanup, key)).toBe(true)
      expect(cleanup[key]).toBeNull()
    }
  })

  it('logs once when the retired-terminal cleanup cannot be persisted', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cleanupError = new Error('cleanup persistence unavailable')
    mockFinalizeTerminalOwnership.mockReturnValue(true)
    mockMarkDispatchResult.mockImplementation(
      async (result: { terminalPaneKey?: string | null }) => {
        if (result.terminalPaneKey === null) {
          throw cleanupError
        }
      }
    )
    let launchArgs: { onAgentStatus?: (payload: { state: string }) => void } = {}
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: AGENT_PANE_KEY,
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
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledOnce())

    expect(errorSpy).toHaveBeenCalledWith(
      '[automations] Failed to clear retired terminal identity:',
      cleanupError
    )
    errorSpy.mockRestore()
  })

  it('ignores a session-boundary done so a connecting agent cannot complete the run (STA-3386)', async () => {
    let launchArgs: {
      onAgentStatus?: (payload: { state: string; sessionBoundary?: boolean }) => void
    } = {}
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      launchArgs = args
      return {
        tabId: 'agent-tab',
        paneKey: AGENT_PANE_KEY,
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
    await registerAndDispatch()
    const transitionStartedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [AGENT_PANE_KEY]: {
        paneKey: AGENT_PANE_KEY,
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
    requireStoreSubscriber()()

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
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'agent-tab',
      paneKey: AGENT_PANE_KEY,
      ptyId: 'agent-pty'
    })
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})

    await registerAndDispatch(makeAutomation({ reuseSession: true }))
    const transitionStartedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [AGENT_PANE_KEY]: {
        paneKey: AGENT_PANE_KEY,
        state: 'working',
        prompt: 'new turn',
        agentType: 'claude',
        updatedAt: transitionStartedAt + 1,
        stateStartedAt: transitionStartedAt + 1,
        stateHistory: [{ state: 'done', prompt: 'old turn', startedAt: transitionStartedAt }]
      }
    }
    const notifyStoreSubscriber = requireStoreSubscriber()

    notifyStoreSubscriber()
    notifyStoreSubscriber()
    await Promise.resolve()

    expect(mockMarkDispatchResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
  })

  // Why: transport loss, PTY exit and cap eviction all drop and recreate the live
  // entry with an empty stateHistory. The working edge is only in the observer's
  // own bookkeeping by then, so it must survive a zero-overlap rescan.
  it('completes a reuse-session run when the entry is recreated with no history', async () => {
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'agent-tab',
      paneKey: AGENT_PANE_KEY,
      ptyId: 'agent-pty'
    })
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})

    await registerAndDispatch(makeAutomation({ reuseSession: true }))
    const workingStartedAt = Date.now() + 1
    state.agentStatusByPaneKey = {
      [AGENT_PANE_KEY]: {
        paneKey: AGENT_PANE_KEY,
        state: 'working',
        prompt: 'turn',
        agentType: 'claude',
        updatedAt: workingStartedAt,
        stateStartedAt: workingStartedAt,
        stateHistory: [{ state: 'working', prompt: 'turn', startedAt: workingStartedAt }]
      }
    }
    const notifyStoreSubscriber = requireStoreSubscriber()
    notifyStoreSubscriber()
    await Promise.resolve()

    // The entry is dropped and recreated: same pane, now done, history gone.
    state.agentStatusByPaneKey = {
      [AGENT_PANE_KEY]: {
        paneKey: AGENT_PANE_KEY,
        state: 'done',
        prompt: 'turn',
        agentType: 'claude',
        updatedAt: workingStartedAt + 2,
        stateStartedAt: workingStartedAt + 2,
        stateHistory: []
      }
    }
    notifyStoreSubscriber()
    await Promise.resolve()

    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
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
        paneKey: AGENT_PANE_KEY,
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
        paneKey: AGENT_PANE_KEY,
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
        paneKey: AGENT_PANE_KEY,
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
        paneKey: AGENT_PANE_KEY,
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
})
