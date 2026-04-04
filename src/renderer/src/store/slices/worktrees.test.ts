import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/types'

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([])
  }
}

// @ts-expect-error -- test shim
globalThis.window = { api: mockApi }

import { createWorktreeSlice } from './worktrees'

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        // Why: this test isolates the worktree slice, so it only provides the
        // state surface that `createWorktreeSlice` reads and writes.
        ...createWorktreeSlice(...a)
      }) as AppState
  )
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not notify subscribers when the fetched payload is unchanged', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const subscriber = vi.fn()

    mockApi.worktrees.list.mockResolvedValue([existing])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const unsubscribe = store.subscribe(subscriber)
    await store.getState().fetchWorktrees('repo1')
    unsubscribe()

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('updates the repo entry and bumps sortEpoch when git reports a branch change', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      displayName: 'feature-one'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-two',
      head: 'def456',
      displayName: 'feature-two'
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })
})
