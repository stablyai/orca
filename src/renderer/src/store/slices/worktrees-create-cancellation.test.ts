import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { CreateWorktreeCallOptions } from './worktrees/create/worktree-create-payload'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})
function create(store: ReturnType<typeof createTestStore>, options: CreateWorktreeCallOptions) {
  const args: Parameters<ReturnType<typeof store.getState>['createWorktree']> = [
    'repo1',
    'feature',
    'main'
  ]
  args[25] = options
  return store.getState().createWorktree(...args)
}

describe('createWorktree cancellation boundaries', () => {
  it('does not dispatch an already cancelled request', async () => {
    const store = createTestStore()
    await expect(create(store, { isCancelled: () => true })).rejects.toThrow('cancelled')
    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
  })

  it('does not retry a conflict after cancellation', async () => {
    const store = createTestStore()
    let cancelled = false
    mockApi.worktrees.create.mockImplementationOnce(async () => {
      cancelled = true
      throw new Error("fatal: a branch named 'feature' already exists")
    })
    await expect(create(store, { isCancelled: () => cancelled })).rejects.toThrow('already exists')
    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(1)
  })

  it('captures the creation host before focus changes and keeps callbacks off the wire', async () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo1',
          displayName: 'repo',
          badgeColor: '',
          addedAt: 1,
          path: '/repo',
          executionHostId: 'ssh:original',
          connectionId: 'original'
        }
      ]
    } as Partial<AppState>)
    const worktree = makeWorktree({ id: 'repo1::/repo/feature', repoId: 'repo1' })
    const onCreated = vi.fn()
    mockApi.worktrees.create.mockImplementationOnce(async () => {
      store.setState({
        repos: [
          {
            id: 'repo1',
            displayName: 'repo',
            badgeColor: '',
            addedAt: 1,
            path: '/repo',
            executionHostId: 'ssh:other',
            connectionId: 'other'
          }
        ]
      } as Partial<AppState>)
      return { worktree }
    })
    await create(store, { isCancelled: () => false, onCreated })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: worktree.id, hostId: 'ssh:original' })
    )
    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(1)
    const payload = mockApi.worktrees.create.mock.calls[0][0]
    expect(payload).not.toHaveProperty('isCancelled')
    expect(payload).not.toHaveProperty('onCreated')
  })

  it('reports a successful late result to cleanup even when cancelled during create', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({ id: 'repo1::/repo/feature', repoId: 'repo1' })
    let cancelled = false
    const onCreated = vi.fn()
    mockApi.worktrees.create.mockImplementationOnce(async () => {
      cancelled = true
      return { worktree }
    })
    await create(store, { isCancelled: () => cancelled, onCreated })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(worktree)
    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(1)
  })
})
