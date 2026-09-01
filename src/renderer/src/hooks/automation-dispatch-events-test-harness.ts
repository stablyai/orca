// Shared fixtures for the useAutomationDispatchEvents suites. The vi.mock calls
// stay in each test file (they are hoisted per module), but their factories read
// the mock functions from here so both files drive one set of doubles.
import type * as ReactModule from 'react'
import { vi, type Mock } from 'vitest'

export const mockLaunchAgentBackgroundSession: Mock = vi.fn()
export const mockLaunchWorktreeBackgroundTerminals: Mock = vi.fn()
export const mockFindReusableAutomationSession: Mock = vi.fn()
export const mockObserveExistingAutomationSession: Mock = vi.fn()
export const mockSubmitPromptToAgentPty: Mock = vi.fn()
export const mockCreateWorktree: Mock = vi.fn()
export const mockMarkDispatchResult: Mock = vi.fn()
export const mockOnDispatchRequested: Mock = vi.fn()
export const mockRendererReady: Mock = vi.fn()
export const mockFinalizeTerminalOwnership: Mock = vi.fn()
export const mockReleaseTerminalOwnership: Mock = vi.fn()
export const mockSshNeedsPassphrasePrompt: Mock = vi.fn()
export const mockSshGetState: Mock = vi.fn()
export const mockSshConnect: Mock = vi.fn()

let latestStoreSubscriber: (() => void) | null = null
export const mockStoreSubscribe = vi.fn((listener: () => void) => {
  latestStoreSubscriber = listener
  return () => {}
})

/** The agent-status observer registered by the last dispatch, or null. */
export function getLatestStoreSubscriber(): (() => void) | null {
  return latestStoreSubscriber
}

export const setupLaunch = {
  runnerScriptPath: '/tmp/setup.sh',
  envVars: { ORCA_WORKTREE_PATH: '/repo/worktree' }
}

export const createdWorktree = {
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

export const state = {
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
  subscribe: vi.fn(() => () => {}) as Mock,
  setActiveView: vi.fn() as Mock,
  setActiveWorktree: vi.fn() as Mock,
  setActiveTab: vi.fn() as Mock,
  setActiveTabType: vi.fn() as Mock
}

export function makeAutomation(overrides: Record<string, unknown> = {}) {
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

export function makeRun() {
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

export async function registerAndDispatch(automation = makeAutomation()): Promise<void> {
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

/** Per-test reset: fresh modules, cleared doubles, default happy-path returns. */
export function resetAutomationDispatchHarness(): void {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  state.activeView = 'terminal'
  state.activeWorktreeId = 'wt-active'
  state.activeTabId = 'tab-active'
  state.activeTabType = 'terminal'
  state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }]
  state.folderWorkspaces = []
  state.projectGroups = []
  state.worktreesByRepo = {}
  state.agentStatusByPaneKey = {}
  latestStoreSubscriber = null
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
        runPrecheck: vi.fn() as Mock,
        listRuns: vi.fn().mockResolvedValue([]) as Mock
      },
      ssh: {
        needsPassphrasePrompt: mockSshNeedsPassphrasePrompt,
        getState: mockSshGetState,
        connect: mockSshConnect
      }
    },
    dispatchEvent: vi.fn() as Mock
  })
}

/** The eight module doubles every dispatch suite installs. Each test file still
 *  declares its own hoisted vi.mock calls; this is the factory bodies' source. */
export const automationRunOutputSnapshotMock = {
  createAutomationRunOutputSnapshotBuffer: () => ({
    append: vi.fn() as Mock,
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
}
