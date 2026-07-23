import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    worktreeMap: new Map<string, unknown>(),
    clearWorktreeDeleteState: vi.fn((worktreeId: string) => {
      delete state.deleteStateByWorktreeId[worktreeId]
    }),
    markWorktreesDeleting: vi.fn((worktreeIds: readonly string[]) => {
      for (const worktreeId of new Set(worktreeIds)) {
        state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
      }
    }),
    removeWorktree: vi.fn().mockResolvedValue({ ok: true }),
    deleteStateByWorktreeId: {} as Record<
      string,
      { isDeleting?: boolean; error?: string | null; canForceDelete?: boolean }
    >
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/store/selectors', () => ({
  getWorktreeMapFromState: () => mocks.state.worktreeMap
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn()
  }
}))

import { toast } from 'sonner'
import { CROSS_REPO_DELETE_CONCURRENCY, runWorktreeDeletesInParallel } from './delete-worktree-flow'

function deferredDeleteResult(): {
  promise: Promise<{ ok: true }>
  resolve: (value: { ok: true }) => void
} {
  let resolve: (value: { ok: true }) => void = () => {}
  const promise = new Promise<{ ok: true }>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('runWorktreeDeletesInParallel', () => {
  beforeEach(() => {
    mocks.state.removeWorktree.mockClear().mockResolvedValue({ ok: true })
    mocks.state.clearWorktreeDeleteState.mockClear()
    mocks.state.markWorktreesDeleting.mockClear()
    mocks.state.deleteStateByWorktreeId = {}
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
  })

  it.each([
    ['at the limit', CROSS_REPO_DELETE_CONCURRENCY],
    ['above the limit', CROSS_REPO_DELETE_CONCURRENCY + 1]
  ])('bounds cross-project deletes %s', async (_, count) => {
    let active = 0
    let peak = 0
    const pending: ReturnType<typeof deferredDeleteResult>[] = []
    mocks.state.removeWorktree.mockImplementation(() => {
      const result = deferredDeleteResult()
      pending.push(result)
      active++
      peak = Math.max(peak, active)
      return result.promise.finally(() => {
        active--
      })
    })
    const targets = Array.from({ length: count }, (_, index) => ({
      id: `wt-${index}`,
      displayName: `workspace ${index}`,
      repoId: `repo-${index}`,
      path: `/workspaces/${index}`
    }))

    const deleted = runWorktreeDeletesInParallel(targets)
    await vi.waitFor(() =>
      expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(
        Math.min(count, CROSS_REPO_DELETE_CONCURRENCY)
      )
    )
    if (count > CROSS_REPO_DELETE_CONCURRENCY) {
      pending.shift()?.resolve({ ok: true })
      await vi.waitFor(() => expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(count))
    }
    pending.splice(0).forEach((result) => result.resolve({ ok: true }))

    await expect(deleted).resolves.toEqual(targets.map((target) => target.id))
    expect(peak).toBe(Math.min(count, CROSS_REPO_DELETE_CONCURRENCY))
  })

  it('starts every selected delete before waiting for earlier deletes to finish', async () => {
    const first = deferredDeleteResult()
    const second = deferredDeleteResult()
    mocks.state.removeWorktree
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const deleted = runWorktreeDeletesInParallel([
      { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
      { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(2)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'wt-1', false)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-2', false)
    expect(mocks.state.markWorktreesDeleting).toHaveBeenCalledWith(['wt-1', 'wt-2'])

    second.resolve({ ok: true })
    await Promise.resolve()
    first.resolve({ ok: true })

    await expect(deleted).resolves.toEqual(['wt-1', 'wt-2'])
  })

  it('marks every same-repo target deleting before serialized deletes finish', async () => {
    const childDelete = deferredDeleteResult()
    mocks.state.removeWorktree.mockReturnValueOnce(childDelete.promise)

    const deleted = runWorktreeDeletesInParallel([
      { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
      { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
    ])

    expect(mocks.state.markWorktreesDeleting).toHaveBeenCalledWith(['parent', 'child'])
    expect(mocks.state.deleteStateByWorktreeId['parent']).toEqual({
      isDeleting: true,
      error: null,
      canForceDelete: false
    })
    expect(mocks.state.deleteStateByWorktreeId['child']).toEqual({
      isDeleting: true,
      error: null,
      canForceDelete: false
    })
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false)

    childDelete.resolve({ ok: true })

    await expect(deleted).resolves.toEqual(['parent', 'child'])
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'parent', false)
  })

  it('deletes nested workspaces before their parent within the same repo', async () => {
    await runWorktreeDeletesInParallel([
      { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
      { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'parent', false)
  })

  it('passes confirmed force to each delete', async () => {
    await runWorktreeDeletesInParallel(
      [
        { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
        { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
      ],
      { force: true }
    )

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'wt-1', true)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-2', true)
  })

  it('clears a pending ancestor when a nested descendant delete fails', async () => {
    mocks.state.removeWorktree.mockImplementationOnce(async (worktreeId: string) => {
      mocks.state.deleteStateByWorktreeId[worktreeId] = {
        isDeleting: false,
        error: 'changed files',
        canForceDelete: true
      }
      return { ok: false, error: 'changed files' }
    })

    await expect(
      runWorktreeDeletesInParallel([
        { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
        { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
      ])
    ).resolves.toEqual([])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false)
    expect(mocks.state.clearWorktreeDeleteState).toHaveBeenCalledWith('parent')
    expect(mocks.state.deleteStateByWorktreeId['parent']).toBeUndefined()
  })
})
