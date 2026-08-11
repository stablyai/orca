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
  getAllWorktreesFromState: () => Array.from(mocks.state.worktreeMap.values()),
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

vi.mock('./preserved-branch-batch-toast', () => ({
  showPreservedBranchBatchToast: vi.fn()
}))

import { toast } from 'sonner'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import { showPreservedBranchBatchToast } from './preserved-branch-batch-toast'

function runDeletesForCurrentWorktrees(
  targets: Parameters<typeof runWorktreeDeletesInParallel>[0],
  options?: Parameters<typeof runWorktreeDeletesInParallel>[1]
) {
  mocks.state.worktreeMap = new Map(targets.map((target) => [target.id, target]))
  return runWorktreeDeletesInParallel(targets, options)
}

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
    mocks.state.removeWorktree.mockReset().mockResolvedValue({ ok: true })
    mocks.state.clearWorktreeDeleteState.mockClear()
    mocks.state.markWorktreesDeleting.mockClear()
    mocks.state.worktreeMap = new Map()
    mocks.state.deleteStateByWorktreeId = {}
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(showPreservedBranchBatchToast).mockClear()
  })

  it('starts every selected delete before waiting for earlier deletes to finish', async () => {
    const first = deferredDeleteResult()
    const second = deferredDeleteResult()
    mocks.state.removeWorktree
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const deleted = runDeletesForCurrentWorktrees([
      { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
      { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(2)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'wt-1', false, {
      suppressPreservedBranchToast: true
    })
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-2', false, {
      suppressPreservedBranchToast: true
    })
    expect(mocks.state.markWorktreesDeleting).toHaveBeenCalledWith(['wt-1', 'wt-2'])

    second.resolve({ ok: true })
    await Promise.resolve()
    first.resolve({ ok: true })

    await expect(deleted).resolves.toEqual(['wt-1', 'wt-2'])
  })

  it('marks every same-repo target deleting before serialized deletes finish', async () => {
    const childDelete = deferredDeleteResult()
    mocks.state.removeWorktree.mockReturnValueOnce(childDelete.promise)

    const deleted = runDeletesForCurrentWorktrees([
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
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false, {
      suppressPreservedBranchToast: true
    })

    childDelete.resolve({ ok: true })

    await expect(deleted).resolves.toEqual(['parent', 'child'])
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'parent', false, {
      suppressPreservedBranchToast: true
    })
  })

  it('deletes nested workspaces before their parent within the same repo', async () => {
    await runDeletesForCurrentWorktrees([
      { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
      { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false, {
      suppressPreservedBranchToast: true
    })
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'parent', false, {
      suppressPreservedBranchToast: true
    })
  })

  it('passes confirmed force to each delete', async () => {
    await runDeletesForCurrentWorktrees(
      [
        { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
        { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
      ],
      { force: true }
    )

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'wt-1', true, {
      suppressPreservedBranchToast: true
    })
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-2', true, {
      suppressPreservedBranchToast: true
    })
  })

  it('deletes a duplicated target identity only once', async () => {
    const target = {
      id: 'wt-1',
      displayName: 'one',
      repoId: 'repo-a',
      path: '/workspaces/one'
    }
    mocks.state.removeWorktree
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'selector_not_found' })

    await expect(runDeletesForCurrentWorktrees([target, target])).resolves.toEqual(['wt-1'])

    expect(mocks.state.markWorktreesDeleting).toHaveBeenCalledWith(['wt-1'])
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-1', false)
    expect(toast.error).not.toHaveBeenCalled()
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
      runDeletesForCurrentWorktrees([
        { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
        { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
      ])
    ).resolves.toEqual([])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false, {
      suppressPreservedBranchToast: true
    })
    expect(mocks.state.clearWorktreeDeleteState).toHaveBeenCalledWith('parent')
    expect(mocks.state.deleteStateByWorktreeId['parent']).toBeUndefined()
  })

  it('replaces per-workspace branch warnings with one batch result', async () => {
    mocks.state.removeWorktree
      .mockResolvedValueOnce({
        ok: true,
        preservedBranch: { branchName: 'feature/one', head: 'head-one' }
      })
      .mockResolvedValueOnce({
        ok: true,
        preservedBranch: { branchName: 'feature/two', head: 'head-two' }
      })

    await expect(
      runDeletesForCurrentWorktrees([
        { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
        { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
      ])
    ).resolves.toEqual(['wt-1', 'wt-2'])

    expect(showPreservedBranchBatchToast).toHaveBeenCalledOnce()
    expect(showPreservedBranchBatchToast).toHaveBeenCalledWith(2, [
      { worktreeId: 'wt-1', branchName: 'feature/one', expectedHead: 'head-one' },
      { worktreeId: 'wt-2', branchName: 'feature/two', expectedHead: 'head-two' }
    ])
  })
})
