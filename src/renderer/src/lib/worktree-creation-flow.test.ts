import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const store = {
  settings: { activeRuntimeEnvironmentId: null as string | null },
  beginPendingWorktreeCreation: vi.fn(),
  updatePendingWorktreeCreation: vi.fn(),
  pendingWorktreeCreations: { 'creation-1': { creationId: 'creation-1' } },
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

import {
  beginBackgroundWorktreePreparation,
  continueBackgroundWorktreeCreation,
  runBackgroundWorktreeCreation
} from './worktree-creation-flow'

const FLOW_SOURCE = readFileSync(join(__dirname, 'worktree-creation-flow.ts'), 'utf8')

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
