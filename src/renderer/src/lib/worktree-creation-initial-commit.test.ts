import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => {
  const state = {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
    activePendingCreationId: null as string | null,
    beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
      state.pendingWorktreeCreations[entry.creationId] = entry
      state.activePendingCreationId = entry.creationId
    }),
    updatePendingWorktreeCreation: vi.fn(
      (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
        const entry = state.pendingWorktreeCreations[creationId]
        if (!entry) {
          return
        }
        state.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    ),
    removePendingWorktreeCreation: vi.fn((creationId: string) => {
      delete state.pendingWorktreeCreations[creationId]
      if (state.activePendingCreationId === creationId) {
        state.activePendingCreationId = null
      }
    }),
    setActivePendingWorktreeCreation: vi.fn((creationId: string | null) => {
      state.activePendingCreationId = creationId
    }),
    setActiveView: vi.fn(),
    setSidebarOpen: vi.fn(),
    createWorktree: vi.fn(),
    updateWorktreeMeta: vi.fn()
  }
  return {
    createInitialCommit: vi.fn(),
    getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' })),
    state,
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: mocks.getActiveRuntimeTarget
}))

vi.mock('@/runtime/runtime-repo-client', () => ({
  createRuntimeRepoInitialCommit: mocks.createInitialCommit
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

import { runBackgroundWorktreeCreation } from './worktree-creation-flow'
import { createInitialCommitAndRetryWorktreeCreation } from './worktree-creation-initial-commit'

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function makeFailedEntry(
  overrides: Partial<PendingWorktreeCreation> = {}
): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'fetching',
    status: 'error',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    error: 'No base branch found',
    errorAction: 'create-initial-commit',
    request: makeRequest(),
    ...overrides
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('worktree creation initial-commit recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'creation-1' })
    mocks.state.settings = { activeRuntimeEnvironmentId: null }
    mocks.state.pendingWorktreeCreations = {}
    mocks.state.activePendingCreationId = null
    mocks.state.beginPendingWorktreeCreation.mockClear()
    mocks.state.updatePendingWorktreeCreation.mockClear()
    mocks.state.removePendingWorktreeCreation.mockClear()
    mocks.state.setActivePendingWorktreeCreation.mockClear()
    mocks.state.setActiveView.mockClear()
    mocks.state.setSidebarOpen.mockClear()
    mocks.state.createWorktree.mockReset()
    mocks.state.updateWorktreeMeta.mockReset()
    mocks.createInitialCommit.mockReset()
    mocks.getActiveRuntimeTarget.mockClear()
    mocks.toastError.mockReset()
  })

  it('stores the formatted recovery action when background creation hits a missing base ref', async () => {
    mocks.state.createWorktree.mockRejectedValueOnce(
      new Error('Could not resolve a default base ref for this repo.')
    )

    runBackgroundWorktreeCreation(makeRequest())
    await flushPromises()

    expect(mocks.state.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'error',
      error: 'No base branch found',
      errorAction: 'create-initial-commit',
      loaderVisible: true
    })
  })

  it('creates the initial commit, patches the explicit base branch, and retries', async () => {
    mocks.state.pendingWorktreeCreations['creation-1'] = makeFailedEntry()
    mocks.createInitialCommit.mockResolvedValueOnce({ ok: true, baseRef: 'trunk' })
    mocks.state.createWorktree.mockImplementationOnce(() => new Promise(() => {}))

    await createInitialCommitAndRetryWorktreeCreation('creation-1')

    expect(mocks.createInitialCommit).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: null },
      'repo-1'
    )
    expect(mocks.state.pendingWorktreeCreations['creation-1']?.request.baseBranch).toBe('trunk')
    expect(mocks.state.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'feature',
      'trunk',
      'inherit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      'creation-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('keeps the recovery action and surfaces the initial commit failure', async () => {
    mocks.state.pendingWorktreeCreations['creation-1'] = makeFailedEntry()
    mocks.createInitialCommit.mockResolvedValueOnce({ ok: false, error: 'git identity missing' })

    await createInitialCommitAndRetryWorktreeCreation('creation-1')

    expect(mocks.state.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'error',
      error: 'git identity missing',
      errorAction: 'create-initial-commit',
      initialCommitPending: false
    })
    expect(mocks.state.createWorktree).not.toHaveBeenCalled()
  })

  it('no-ops when the failed creation is dismissed mid-action', async () => {
    mocks.state.pendingWorktreeCreations['creation-1'] = makeFailedEntry()
    mocks.createInitialCommit.mockImplementationOnce(async () => {
      delete mocks.state.pendingWorktreeCreations['creation-1']
      return { ok: true, baseRef: 'main' }
    })

    await createInitialCommitAndRetryWorktreeCreation('creation-1')

    expect(mocks.state.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(mocks.state.createWorktree).not.toHaveBeenCalled()
  })
})
