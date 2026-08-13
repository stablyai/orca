import { beforeEach, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => {
  const store = {
    activePendingCreationId: null as string | null,
    activeView: 'terminal',
    pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
    repos: [],
    settings: {},
    beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
      store.pendingWorktreeCreations[entry.creationId] = entry
      store.activePendingCreationId = entry.creationId
    }),
    updatePendingWorktreeCreation: vi.fn(),
    removePendingWorktreeCreation: vi.fn((creationId: string) => {
      delete store.pendingWorktreeCreations[creationId]
    }),
    createWorktree: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    setActivePendingWorktreeCreation: vi.fn(),
    setActiveView: vi.fn(),
    setSidebarOpen: vi.fn()
  }
  return {
    store,
    activateAndRevealWorktree: vi.fn(() => ({ primaryTabId: null })),
    ensureWorktreeHasInitialTerminal: vi.fn(),
    toastError: vi.fn(),
    seedAgentTabState: vi.fn(),
    ensureAgentStartup: vi.fn(),
    markTrusted: vi.fn(),
    resolveExplicitRoute: vi.fn<
      () =>
        | {
            kind: 'resolved'
            route: { executionHostId: 'ssh:requested'; runtimeEnvironmentId: null }
          }
        | { kind: 'ambiguous' }
    >(() => ({
      kind: 'resolved',
      route: { executionHostId: 'ssh:requested', runtimeEnvironmentId: null }
    })),
    prepareRequestForCreate: vi.fn(
      async (_creationId: string, request: WorktreeCreationRequest) => request
    )
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'creation-host-routing' }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree,
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))
vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: mocks.prepareRequestForCreate,
  adoptEphemeralVmProvisionedRoot: vi.fn(),
  attachEphemeralVmRuntimeToWorkspace: vi.fn(),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn()
}))
vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: mocks.seedAgentTabState
}))
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveExplicitWorktreeOperationRouteResult: mocks.resolveExplicitRoute
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: mocks.ensureAgentStartup }))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.activePendingCreationId = null
  mocks.store.activeView = 'terminal'
  mocks.store.pendingWorktreeCreations = {}
  mocks.store.repos = []
  mocks.resolveExplicitRoute.mockReturnValue({
    kind: 'resolved',
    route: { executionHostId: 'ssh:requested', runtimeEnvironmentId: null }
  })
  mocks.store.createWorktree.mockResolvedValue({
    worktree: { id: 'wt-shared', repoId: 'repo-1', hostId: 'ssh:requested' }
  })
  globalThis.window = { api: { agentTrust: { markTrusted: mocks.markTrusted } } } as never
})

it('preflights agent trust on the requested host when repo ids collide', async () => {
  mocks.store.repos = [
    { id: 'repo-1', connectionId: 'sibling', executionHostId: 'ssh:sibling' },
    { id: 'repo-1', connectionId: 'requested', executionHostId: 'ssh:requested' }
  ] as never
  mocks.store.createWorktree.mockResolvedValue({
    worktree: {
      id: 'wt-shared',
      repoId: 'repo-1',
      hostId: 'ssh:requested',
      path: '/workspace'
    }
  })

  runBackgroundWorktreeCreation({
    repoId: 'repo-1',
    name: 'remote-workspace',
    setupDecision: 'inherit',
    agent: 'codex',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  })

  await vi.waitFor(() =>
    expect(mocks.markTrusted).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'requested' })
    )
  )
})

it('fails background startup closed when duplicate hosts make the bare id ambiguous', async () => {
  mocks.store.activeView = 'tasks'
  mocks.resolveExplicitRoute.mockReturnValue({ kind: 'ambiguous' })

  runBackgroundWorktreeCreation({
    repoId: 'repo-1',
    name: 'remote-workspace',
    setupDecision: 'inherit',
    agent: 'codex',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: {
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agent: 'codex', command: 'codex' }
    } as never,
    quickPrompt: '',
    quickTelemetry: null
  })

  await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
  expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  expect(mocks.seedAgentTabState).not.toHaveBeenCalled()
  expect(mocks.ensureAgentStartup).not.toHaveBeenCalled()
})

it('keeps remote host ownership through activation and note persistence', async () => {
  runBackgroundWorktreeCreation({
    repoId: 'repo-1',
    name: 'remote-workspace',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: 'Remote note',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  })

  await vi.waitFor(() =>
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-shared', {
      sidebarRevealBehavior: 'auto',
      executionHostId: 'ssh:requested'
    })
  )
  await vi.waitFor(() =>
    expect(mocks.store.updateWorktreeMeta).toHaveBeenCalledWith(
      'wt-shared',
      { comment: 'Remote note' },
      { executionHostId: 'ssh:requested' }
    )
  )
})
