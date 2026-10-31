import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const pendingWorktreeCreations: Record<string, PendingWorktreeCreation> = {}
const store = {
  pendingWorktreeCreations,
  activeView: 'terminal',
  activePendingCreationId: 'creation-1',
  settings: null,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
  }),
  updatePendingWorktreeCreation: vi.fn((id: string, patch: Partial<PendingWorktreeCreation>) => {
    const entry = store.pendingWorktreeCreations[id]
    if (entry) {
      store.pendingWorktreeCreations[id] = { ...entry, ...patch }
    }
  }),
  removePendingWorktreeCreation: vi.fn((id: string) => {
    delete store.pendingWorktreeCreations[id]
  }),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {}))
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'creation-1' }))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn(),
  readAndConfirmRuntimeIssueCommand: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { ensureHooksConfirmed } from './ensure-hooks-confirmed'
import {
  runBackgroundWorktreeCreation,
  retryBackgroundWorktreeCreation
} from './worktree-creation-flow'

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    worktreeCreateProgressMode: 'stepped',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.pendingWorktreeCreations = {}
})

async function flushAsyncWorktreeCreation(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('background script preparation', () => {
  it('shows preparation immediately and waits for trust before creating', async () => {
    const trust = Promise.withResolvers<'run' | 'skip'>()
    vi.mocked(ensureHooksConfirmed).mockReturnValueOnce(trust.promise)
    const request = makeRequest({ hookPreparation: { executionHostId: 'ssh:remote-1' } })

    runBackgroundWorktreeCreation(request)

    expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
      phase: 'preparing',
      loaderVisible: true,
      status: 'creating',
      request
    })
    expect(store.createWorktree).not.toHaveBeenCalled()
    expect(ensureHooksConfirmed).toHaveBeenCalledWith(
      expect.any(Function),
      'repo-1',
      'setup',
      'ssh:remote-1',
      undefined,
      expect.any(Function)
    )

    trust.resolve('run')
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledOnce())
    expect(store.pendingWorktreeCreations['creation-1'].phase).toBe('fetching')
    expect(store.createWorktree.mock.calls[0]).toContainEqual(
      expect.objectContaining({ executionHostId: 'ssh:remote-1' })
    )
  })

  it('does not create after cancellation during slow script inspection', async () => {
    const trust = Promise.withResolvers<'run' | 'skip'>()
    vi.mocked(ensureHooksConfirmed).mockReturnValueOnce(trust.promise)
    runBackgroundWorktreeCreation(makeRequest({ hookPreparation: { executionHostId: 'local' } }))

    store.removePendingWorktreeCreation('creation-1')
    trust.resolve('run')
    await flushAsyncWorktreeCreation()
    expect(store.createWorktree).not.toHaveBeenCalled()
  })

  it('keeps refused scripts disabled when creating the worktree', async () => {
    vi.mocked(ensureHooksConfirmed).mockResolvedValueOnce('skip')
    runBackgroundWorktreeCreation(
      makeRequest({
        setupDecision: 'run',
        hookPreparation: { executionHostId: 'local' }
      })
    )
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledOnce())
    expect(store.pendingWorktreeCreations['creation-1'].request.setupDecision).toBe('skip')
  })

  it('retries failed preparation on the captured host', async () => {
    vi.mocked(ensureHooksConfirmed).mockRejectedValueOnce(new Error('inspection failed'))
    runBackgroundWorktreeCreation(
      makeRequest({ hookPreparation: { executionHostId: 'runtime:host-1' } })
    )
    await vi.waitFor(() =>
      expect(store.pendingWorktreeCreations['creation-1'].status).toBe('error')
    )
    expect(store.createWorktree).not.toHaveBeenCalled()

    const trust = Promise.withResolvers<'run' | 'skip'>()
    vi.mocked(ensureHooksConfirmed).mockReturnValueOnce(trust.promise)
    retryBackgroundWorktreeCreation('creation-1')
    expect(store.pendingWorktreeCreations['creation-1'].phase).toBe('preparing')
    trust.resolve('run')
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledOnce())
  })
})
