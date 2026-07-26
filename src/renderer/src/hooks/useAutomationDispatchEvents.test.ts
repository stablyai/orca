import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLaunchAgentBackgroundSession = vi.fn()
const mockLaunchWorktreeBackgroundTerminals = vi.fn()
const mockSubmitPromptToAgentTab = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockCreateWorktree = vi.fn()
const mockMarkDispatchResult = vi.fn()
const mockOnDispatchRequested = vi.fn()
const mockRendererReady = vi.fn()
const mockFinalizeTerminalOwnership = vi.fn()
const mockReleaseTerminalOwnership = vi.fn()

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

const state = {
  activeView: 'terminal' as const,
  activeWorktreeId: 'wt-active',
  activeTabId: 'tab-active',
  activeTabType: 'terminal' as const,
  repos: [{ id: 'repo-1', connectionId: null }],
  agentStatusByPaneKey: {},
  allWorktrees: vi.fn<() => TestWorktree[]>(() => []),
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
  submitPromptToAgentTab: mockSubmitPromptToAgentTab
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
    snapshot: () => ''
  }),
  selectAutomationRunOutputSnapshot: () => null
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
    subscribe: vi.fn(() => () => {})
  }
}))

describe('useAutomationDispatchEvents setup launch', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    state.activeView = 'terminal'
    state.activeWorktreeId = 'wt-active'
    state.activeTabId = 'tab-active'
    state.activeTabType = 'terminal'
    state.repos = [{ id: 'repo-1', connectionId: null }]
    state.agentStatusByPaneKey = {}
    state.allWorktrees.mockReturnValue([])
    mockCreateWorktree.mockResolvedValue({ worktree: createdWorktree, setup: setupLaunch })
    mockLaunchWorktreeBackgroundTerminals.mockResolvedValue(undefined)
    mockLaunchAgentBackgroundSession.mockResolvedValue({
      tabId: 'agent-tab',
      paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
      ptyId: 'agent-pty',
      startupPlan: {},
      terminalOwnership: {
        finalize: mockFinalizeTerminalOwnership,
        release: mockReleaseTerminalOwnership
      }
    })
    mockOnDispatchRequested.mockReturnValue(() => {})
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
          needsPassphrasePrompt: vi.fn().mockResolvedValue(false),
          getState: vi.fn().mockResolvedValue({ status: 'connected' }),
          connect: vi.fn()
        }
      },
      dispatchEvent: vi.fn()
    })
  })

  it('starts setup terminal launch without waiting before launching the automation agent', async () => {
    const order: string[] = []
    let finishSetupLaunch: (() => void) | null = null
    mockLaunchWorktreeBackgroundTerminals.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSetupLaunch = () => {
            order.push('setup')
            resolve()
          }
        })
    )
    mockLaunchAgentBackgroundSession.mockImplementation(async () => {
      order.push('agent')
      return { tabId: 'agent-tab', ptyId: 'agent-pty', startupPlan: {} }
    })

    await registerAndDispatch()

    expect(mockCreateWorktree).toHaveBeenCalled()
    expect(mockCreateWorktree.mock.calls[0][3]).toBe('run')
    expect(mockLaunchWorktreeBackgroundTerminals).toHaveBeenCalledWith({
      worktreeId: 'wt-created',
      setup: setupLaunch,
      defaultTabs: undefined
    })
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-created',
        prompt: 'run this'
      })
    )
    expect(order).toEqual(['agent'])
    expect(finishSetupLaunch).not.toBeNull()
    const completeSetupLaunch = finishSetupLaunch as unknown as () => void
    completeSetupLaunch()
    await Promise.resolve()
    expect(order).toEqual(['agent', 'setup'])
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatched',
        workspaceId: 'wt-created',
        terminalSessionId: 'agent-tab'
      })
    )
  })

  it('launches setup and default tabs without activating the created worktree', async () => {
    const defaultTabs = {
      tabs: [{ title: 'Dev', command: 'pnpm dev' }],
      runCommands: true
    }
    mockCreateWorktree.mockResolvedValue({
      worktree: createdWorktree,
      setup: setupLaunch,
      defaultTabs
    })

    await registerAndDispatch()

    expect(mockLaunchWorktreeBackgroundTerminals).toHaveBeenCalledWith({
      worktreeId: 'wt-created',
      setup: setupLaunch,
      defaultTabs
    })
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-created',
        prompt: 'run this'
      })
    )
  })

  it('defaults legacy automations without a setup choice to skipping setup', async () => {
    await registerAndDispatch(makeAutomation({ setupDecision: undefined }))

    expect(mockCreateWorktree.mock.calls[0][3]).toBe('skip')
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalled()
  })

  it('keeps launching the agent when background setup terminal launch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockLaunchWorktreeBackgroundTerminals.mockRejectedValue(new Error('tab launch failed'))

    try {
      await registerAndDispatch()
    } finally {
      warnSpy.mockRestore()
    }

    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-created',
        prompt: 'run this'
      })
    )
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatched',
        workspaceId: 'wt-created',
        terminalSessionId: 'agent-tab'
      })
    )
  })

  it('does not rerun setup for existing-worktree automations', async () => {
    const existingWorktree = {
      id: 'wt-existing',
      repoId: 'repo-1',
      displayName: 'Existing workspace',
      path: '/repo/existing'
    }
    state.allWorktrees.mockReturnValue([existingWorktree])

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: 'wt-existing',
        setupDecision: 'run'
      })
    )

    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockLaunchWorktreeBackgroundTerminals).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-existing',
        prompt: 'run this'
      })
    )
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
})
