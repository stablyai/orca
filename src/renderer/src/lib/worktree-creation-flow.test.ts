import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

type TestActiveView = 'terminal' | 'tasks'

const store = {
  settings: { activeRuntimeEnvironmentId: null as string | null },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [] as { id: string; connectionId?: string | null }[],
  beginPendingWorktreeCreation: vi.fn(),
  updatePendingWorktreeCreation: vi.fn(),
  pendingWorktreeCreations: { 'creation-1': { creationId: 'creation-1' } } as Record<
    string,
    { creationId: string; request?: WorktreeCreationRequest }
  >,
  removePendingWorktreeCreation: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {}))
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

import { toast } from 'sonner'
import {
  activateAndRevealWorktree,
  ensureWorktreeHasInitialTerminal
} from '@/lib/worktree-activation'
import { queueNewWorkspaceTerminalFocus } from '@/lib/new-workspace-terminal-focus'
import {
  beginBackgroundWorktreePreparation,
  continueBackgroundWorktreeCreation,
  runBackgroundWorktreeCreation
} from './worktree-creation-flow'

const FLOW_SOURCE = readFileSync(join(__dirname, 'worktree-creation-flow.ts'), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.activeView = 'terminal'
  store.activePendingCreationId = 'creation-1'
  store.repos = []
  store.pendingWorktreeCreations = { 'creation-1': { creationId: 'creation-1' } }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
  vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
})

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

async function flushAsyncWorktreeCreation(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('runBackgroundWorktreeCreation', () => {
  it('uses the captured repo-owner progress mode instead of focused runtime state', () => {
    store.settings.activeRuntimeEnvironmentId = null
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest({ worktreeCreateProgressMode: 'indeterminate' }))

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        indeterminate: true,
        request: expect.objectContaining({
          worktreeCreateProgressMode: 'indeterminate'
        })
      })
    )
  })

  it('falls back to focused runtime state for legacy captured requests', () => {
    store.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest())

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        indeterminate: true,
        request: expect.not.objectContaining({
          worktreeCreateProgressMode: expect.any(String)
        })
      })
    )
  })
})

describe('staged background worktree creation', () => {
  it('shows a pending preparing row before async preflight finishes', () => {
    store.beginPendingWorktreeCreation.mockClear()

    const creationId = beginBackgroundWorktreePreparation(makeRequest({ displayName: 'Issue 42' }))

    expect(creationId).toBe('creation-1')
    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        phase: 'preparing',
        request: expect.objectContaining({ displayName: 'Issue 42' })
      })
    )
  })

  it('replaces the staged request before the create starts', () => {
    store.updatePendingWorktreeCreation.mockClear()
    store.createWorktree.mockClear()
    store.setActivePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()

    const request = makeRequest({ setupDecision: 'run' })
    const started = continueBackgroundWorktreeCreation('creation-1', request)

    expect(started).toBe(true)
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        phase: 'fetching',
        request
      })
    )
    expect(store.createWorktree).toHaveBeenCalledTimes(1)
    const createCall = store.createWorktree.mock.calls[0] as unknown[] | undefined
    expect(createCall).toBeDefined()
    expect(createCall?.[0]).toBe('repo-1')
    expect(createCall?.[1]).toBe('feature')
    expect(createCall?.[3]).toBe('run')
    expect(createCall?.[18]).toBe('creation-1')
    expect(store.setActivePendingWorktreeCreation).toHaveBeenCalledWith('creation-1')
    expect(store.setActiveView).toHaveBeenCalledWith('terminal')
    expect(store.setSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('can continue without revealing a staged create after background preflight', () => {
    store.updatePendingWorktreeCreation.mockClear()
    store.createWorktree.mockClear()
    store.setActivePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()

    const request = makeRequest({ setupDecision: 'run' })
    const started = continueBackgroundWorktreeCreation('creation-1', request, {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        phase: 'fetching',
        request
      })
    )
    expect(store.createWorktree).toHaveBeenCalledTimes(1)
    expect(store.setActivePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(store.setActiveView).not.toHaveBeenCalled()
    expect(store.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('does not reveal a completed staged create after the user leaves the creation surface', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1'
      }
    })

    const started = continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    await flushAsyncWorktreeCreation()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(queueNewWorkspaceTerminalFocus).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1')
  })

  it('toasts a staged create error after the user leaves the creation surface', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockRejectedValueOnce(new Error('create failed'))

    const started = continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    await flushAsyncWorktreeCreation()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        status: 'error'
      })
    )
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})

describe('worktree creation flow agent trust preflight', () => {
  it('forwards the repo SSH connection id when pre-marking agent trust', () => {
    const preflight = sourceBetween(
      FLOW_SOURCE,
      'async function preflightAgentTrust',
      'async function executeWorktreeCreation'
    )
    const createFlow = sourceBetween(
      FLOW_SOURCE,
      'const backendSpawned = result.startupTerminal?.spawned === true',
      '// `createWorktree` already inserted the real worktree row'
    )

    expect(preflight).toContain('connectionId?: string | null')
    expect(preflight).toContain('...(connectionId ? { connectionId } : {})')
    expect(createFlow).toContain('repoConnectionId')
    expect(createFlow).toContain('repo.id === worktree.repoId')
    expect(createFlow).toContain(
      'await preflightAgentTrust(request, worktree.path, repoConnectionId)'
    )
  })
})
