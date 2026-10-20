import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDispatchEvent = vi.fn()

const mockLaunchAgentBackgroundSession = vi.fn()
const mockLaunchWorktreeBackgroundTerminals = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockSubmitPromptToAgentPty = vi.fn()
const mockCreateWorktree = vi.fn()
const mockMarkDispatchResult = vi.fn()
const mockOnDispatchRequested = vi.fn()
const mockRendererReady = vi.fn()
const mockFinalizeTerminalOwnership = vi.fn()
const mockReleaseTerminalOwnership = vi.fn()
const mockSshNeedsPassphrasePrompt = vi.fn()
const mockSshGetState = vi.fn()
const mockSshConnect = vi.fn()
const storeSubscribers = new Set<() => void>()
const effectCleanups: (() => void)[] = []
const mockUnsubscribeDispatch = vi.fn()
const mockStoreSubscribe = vi.fn((listener: () => void) => {
  storeSubscribers.add(listener)
  return () => storeSubscribers.delete(listener)
})

function notifyStoreSubscribers(): void {
  for (const listener of storeSubscribers) {
    listener()
  }
}

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
  hydrationSucceeded: true,
  terminalStartupRestorationReady: true,
  workspaceSessionReady: true,
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

async function registerDispatchEvents(): Promise<void> {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        const cleanup = effect()
        if (cleanup) {
          effectCleanups.push(cleanup)
        }
      }
    }
  })
  const { useAutomationDispatchEvents: registerAutomationDispatchEvents } =
    await import('./useAutomationDispatchEvents')
  registerAutomationDispatchEvents()
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

// The reuse path reads run history over the local runtime target, not IPC.
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn().mockResolvedValue([])
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

describe('useAutomationDispatchEvents startup readiness', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    storeSubscribers.clear()
    state.hydrationSucceeded = true
    state.terminalStartupRestorationReady = true
    state.workspaceSessionReady = true
    state.activeView = 'terminal'
    state.activeWorktreeId = 'wt-active'
    state.activeTabId = 'tab-active'
    state.activeTabType = 'terminal'
    state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }]
    state.folderWorkspaces = []
    state.projectGroups = []
    state.worktreesByRepo = {}
    state.agentStatusByPaneKey = {}
    state.allWorktrees.mockReturnValue([])
    state.getKnownWorktreeById.mockReturnValue(undefined)
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
    mockOnDispatchRequested.mockReturnValue(mockUnsubscribeDispatch)
    mockRendererReady.mockReset().mockResolvedValue(undefined)
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
          runPrecheck: vi.fn()
        },
        ssh: {
          needsPassphrasePrompt: mockSshNeedsPassphrasePrompt,
          getState: mockSshGetState,
          connect: mockSshConnect
        }
      },
      dispatchEvent: mockDispatchEvent
    })
  })

  afterEach(() => {
    for (const cleanup of effectCleanups.splice(0)) {
      cleanup()
    }
    storeSubscribers.clear()
  })

  it('waits for successful hydration and terminal restoration before dispatching the scheduled request', async () => {
    state.repos = []
    state.hydrationSucceeded = false
    state.terminalStartupRestorationReady = false
    const request = {
      automation: makeAutomation({ workspaceMode: 'existing', workspaceId: createdWorktree.id }),
      run: makeRun(),
      dispatchToken: 'original-scheduled-dispatch-token'
    }
    mockRendererReady.mockImplementation(async () => {
      notifyStoreSubscribers()
      const handler = mockOnDispatchRequested.mock.calls[0]?.[0]
      if (!handler) {
        throw new Error('readiness preceded the dispatch subscription')
      }
      await handler(request)
    })

    await registerDispatchEvents()

    expect(mockOnDispatchRequested).toHaveBeenCalledOnce()
    expect.soft(mockRendererReady).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).not.toHaveBeenCalled()
    expect(window.api.automations.runPrecheck).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()

    state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }]
    state.worktreesByRepo = { 'repo-1': [createdWorktree] }
    state.allWorktrees.mockReturnValue([createdWorktree])
    state.hydrationSucceeded = true
    state.terminalStartupRestorationReady = true
    notifyStoreSubscribers()

    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: request.run.id,
          status: 'dispatched',
          workspaceId: createdWorktree.id
        })
      )
    )
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: createdWorktree.id, prompt: request.automation.prompt })
    )
    expect(mockMarkDispatchResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_unavailable' })
    )
    notifyStoreSubscribers()
    notifyStoreSubscribers()
    expect(mockRendererReady).toHaveBeenCalledOnce()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledOnce()
  })

  it.each([
    { hydrationSucceeded: false, terminalStartupRestorationReady: false },
    { hydrationSucceeded: true, terminalStartupRestorationReady: false },
    { hydrationSucceeded: false, terminalStartupRestorationReady: true }
  ])('does not announce partial or degraded startup readiness: %o', async (readiness) => {
    Object.assign(state, readiness)
    state.workspaceSessionReady = true

    await registerDispatchEvents()
    notifyStoreSubscribers()
    notifyStoreSubscribers()

    expect(mockRendererReady).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).not.toHaveBeenCalled()
    expect(window.api.automations.runPrecheck).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
  })

  it('removes subscriptions and ignores hydration completion after cleanup', async () => {
    state.hydrationSucceeded = false
    state.terminalStartupRestorationReady = false
    await registerDispatchEvents()
    const pendingListeners = [...storeSubscribers]
    expect(pendingListeners).toHaveLength(1)

    for (const cleanup of effectCleanups.splice(0)) {
      cleanup()
    }
    expect(mockUnsubscribeDispatch).toHaveBeenCalledOnce()
    expect(storeSubscribers.size).toBe(0)
    state.hydrationSucceeded = true
    state.terminalStartupRestorationReady = true
    notifyStoreSubscribers()
    for (const listener of pendingListeners) {
      listener()
    }

    expect(mockRendererReady).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
  })

  it('handles a rejected readiness announcement once without retrying on store updates', async () => {
    const readinessError = new Error('readiness IPC unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockRendererReady.mockRejectedValueOnce(readinessError)
    try {
      await registerDispatchEvents()
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledOnce())
      notifyStoreSubscribers()
      notifyStoreSubscribers()
      expect(mockRendererReady).toHaveBeenCalledOnce()
      expect(errorSpy).toHaveBeenCalledWith(
        '[automations] Failed to announce renderer readiness:',
        readinessError
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('preserves the unavailable result for a genuinely missing project after hydration', async () => {
    state.repos = []
    mockRendererReady.mockImplementation(async () => {
      const handler = mockOnDispatchRequested.mock.calls[0]?.[0]
      if (!handler) {
        throw new Error('dispatch handler was not registered')
      }
      await handler({
        automation: makeAutomation(),
        run: makeRun(),
        dispatchToken: 'missing-project'
      })
    })

    await registerDispatchEvents()

    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'skipped_unavailable',
          error: 'The target project is no longer available.'
        })
      )
    )
    expect(mockRendererReady).toHaveBeenCalledOnce()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
  })
})
