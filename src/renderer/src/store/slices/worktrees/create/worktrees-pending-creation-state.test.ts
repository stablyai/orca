import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
})

function makePendingCreation(
  creationId: string,
  overrides: Partial<PendingWorktreeCreation> = {}
): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'fetching',
    status: 'creating',
    startedAt: 1000,
    indeterminate: false,
    loaderVisible: false,
    request: {
      repoId: 'repo1',
      name: 'feature',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    },
    ...overrides
  }
}

describe('pending worktree creation state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('keeps composer picks when stale preparation lands with prior chat options', () => {
    const store = createTestStore()
    const request = {
      ...makePendingCreation('c1').request,
      agent: 'codex' as const,
      launchInputs: {
        sessionOptions: { effort: 'high', permissionMode: 'ask' },
        chatSessionOptions: { effort: 'high' }
      }
    }
    store.getState().beginPendingWorktreeCreation(makePendingCreation('c1', { request }))
    store.getState().updatePendingWorktreeCreation('c1', {
      chatSessionOptions: { effort: 'low' }
    })
    store.getState().updatePendingWorktreeCreation('c1', {
      chatSessionOptions: { fastMode: 'true' }
    })

    store.getState().updatePendingWorktreeCreation('c1', {
      request: {
        ...request,
        setupDecision: 'skip',
        hookPreparation: undefined,
        executionHostId: 'runtime:host-1',
        launchInputs: { ...request.launchInputs, agentArgs: '--sandbox workspace-write' }
      },
      phase: 'creating'
    })

    const current = store.getState().pendingWorktreeCreations.c1
    expect(current?.request).toMatchObject({
      setupDecision: 'skip',
      executionHostId: 'runtime:host-1',
      launchInputs: {
        sessionOptions: { effort: 'high', permissionMode: 'ask' },
        agentArgs: '--sandbox workspace-write',
        chatSessionOptions: { effort: 'low', fastMode: 'true' }
      }
    })
    expect(current?.request.launchInputs?.chatSessionOptions?.model).toBeUndefined()
    expect(current?.phase).toBe('creating')
  })
})
