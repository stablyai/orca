import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    worktreeMap: new Map<string, unknown>(),
    worktreeRows: [] as unknown[],
    activeWorkspaceExecutionHostId: null as string | null,
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
  getAllWorktreesFromState: () => mocks.state.worktreeRows,
  getWorktreeMapFromState: () => mocks.state.worktreeMap,
  // Host-qualified lookup (STA-4343); this fixture keys one row per id, so the
  // host only has to agree when the row declares one.
  getWorktreeOnHostFromState: (_state: unknown, worktreeId: string, hostId?: string) => {
    const rows = mocks.state.worktreeRows.filter(
      (row) => (row as { id?: string }).id === worktreeId
    ) as { hostId?: string }[]
    return hostId ? rows.find((row) => row.hostId === hostId) : rows[0]
  }
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
  mocks.state.worktreeRows = [...targets]
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
    mocks.state.worktreeRows = []
    mocks.state.activeWorkspaceExecutionHostId = null
    mocks.state.deleteStateByWorktreeId = {}
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(showPreservedBranchBatchToast).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses one snapshot prune batch for a 100-workspace delete', async () => {
    const begin = vi.fn(async (_args: { batchId: string }) => undefined)
    const record = vi.fn(async (_args: { batchId: string; worktreeId: string }) => undefined)
    const finish = vi.fn(async (_args: { batchId: string }) => undefined)
    vi.stubGlobal('window', {
      api: {
        workspaceCleanup: {
          beginRemovalSnapshotPruneBatch: begin,
          recordRemovalSnapshotPrune: record,
          finishRemovalSnapshotPruneBatch: finish
        }
      }
    })
    const targets = Array.from({ length: 100 }, (_, index) => ({
      id: `wt-${index}`,
      displayName: `workspace ${index}`,
      repoId: `repo-${index % 10}`,
      path: `/workspaces/${index}`
    }))

    await expect(runDeletesForCurrentWorktrees(targets)).resolves.toHaveLength(100)

    expect(begin).toHaveBeenCalledOnce()
    const batchId = begin.mock.calls[0]?.[0].batchId
    expect(batchId).toEqual(expect.any(String))
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(100)
    for (const call of mocks.state.removeWorktree.mock.calls) {
      expect(call[2]).toMatchObject({ snapshotPruneBatchId: batchId })
    }
    expect(finish).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledWith({ batchId })
    expect(record).not.toHaveBeenCalled()
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
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      1,
      { id: 'wt-1', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      2,
      { id: 'wt-2', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
    expect(mocks.state.markWorktreesDeleting).toHaveBeenCalledWith(['wt-1', 'wt-2'])

    second.resolve({ ok: true })
    await Promise.resolve()
    first.resolve({ ok: true })

    await expect(deleted).resolves.toEqual([
      { id: 'wt-1', executionHostId: null },
      { id: 'wt-2', executionHostId: null }
    ])
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
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      1,
      { id: 'child', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )

    childDelete.resolve({ ok: true })

    await expect(deleted).resolves.toEqual([
      { id: 'parent', executionHostId: null },
      { id: 'child', executionHostId: null }
    ])
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      2,
      { id: 'parent', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
  })

  it('deletes nested workspaces before their parent within the same repo', async () => {
    await runDeletesForCurrentWorktrees([
      { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
      { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      1,
      { id: 'child', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      2,
      { id: 'parent', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
  })

  it('passes confirmed force to each delete', async () => {
    await runDeletesForCurrentWorktrees(
      [
        { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
        { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
      ],
      { force: true }
    )

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      1,
      { id: 'wt-1', executionHostId: null },
      true,
      {
        suppressPreservedBranchToast: true
      }
    )
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      2,
      { id: 'wt-2', executionHostId: null },
      true,
      {
        suppressPreservedBranchToast: true
      }
    )
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

    await expect(runDeletesForCurrentWorktrees([target, target])).resolves.toEqual([
      { id: 'wt-1', executionHostId: null }
    ])

    expect(mocks.state.markWorktreesDeleting).toHaveBeenCalledWith(['wt-1'])
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith(
      { id: 'wt-1', executionHostId: null },
      false
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('deletes both host-qualified targets when they share a worktree id', async () => {
    const targets = [
      {
        id: 'shared',
        instanceId: 'local-instance',
        displayName: 'local',
        repoId: 'repo-a',
        path: '/workspaces/shared',
        hostId: 'local' as const
      },
      {
        id: 'shared',
        instanceId: 'ssh-instance',
        displayName: 'ssh',
        repoId: 'repo-a',
        path: '/workspaces/shared',
        hostId: 'ssh:builder' as const
      }
    ]

    await expect(runDeletesForCurrentWorktrees(targets)).resolves.toEqual([
      { id: 'shared', executionHostId: 'local' },
      { id: 'shared', executionHostId: 'ssh:builder' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(2)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      1,
      { id: 'shared', executionHostId: 'local' },
      false,
      { suppressPreservedBranchToast: true }
    )
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      2,
      { id: 'shared', executionHostId: 'ssh:builder' },
      false,
      { suppressPreservedBranchToast: true }
    )
  })

  it('clears a pending ancestor when a nested descendant delete fails', async () => {
    mocks.state.removeWorktree.mockImplementationOnce(
      async ({ id: worktreeId }: { id: string }) => {
        mocks.state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: false,
          error: 'changed files',
          canForceDelete: true
        }
        return { ok: false, error: 'changed files' }
      }
    )

    await expect(
      runDeletesForCurrentWorktrees([
        { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
        { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
      ])
    ).resolves.toEqual([])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
      1,
      { id: 'child', executionHostId: null },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
    expect(mocks.state.clearWorktreeDeleteState).toHaveBeenCalledWith('parent')
    expect(mocks.state.deleteStateByWorktreeId['parent']).toBeUndefined()
  })

  it('does not let a failed child on one host block an ancestor on another host', async () => {
    const hostAChild = {
      id: 'child-a',
      instanceId: 'child-a-instance',
      displayName: 'child A',
      repoId: 'repo-a',
      path: '/workspaces/parent/child',
      hostId: 'ssh:host-a' as const
    }
    const hostBParent = {
      id: 'parent-b',
      instanceId: 'parent-b-instance',
      displayName: 'parent B',
      repoId: 'repo-a',
      path: '/workspaces/parent',
      hostId: 'ssh:host-b' as const
    }
    mocks.state.removeWorktree.mockImplementation(
      async ({ executionHostId }: { executionHostId: string | null }) =>
        executionHostId === hostAChild.hostId ? { ok: false, error: 'changed files' } : { ok: true }
    )

    await expect(runDeletesForCurrentWorktrees([hostAChild, hostBParent])).resolves.toEqual([
      { id: hostBParent.id, executionHostId: hostBParent.hostId }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(2)
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith(
      { id: hostBParent.id, executionHostId: hostBParent.hostId },
      false,
      { suppressPreservedBranchToast: true }
    )
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
    ).resolves.toEqual([
      { id: 'wt-1', executionHostId: null },
      { id: 'wt-2', executionHostId: null }
    ])

    expect(showPreservedBranchBatchToast).toHaveBeenCalledOnce()
    expect(showPreservedBranchBatchToast).toHaveBeenCalledWith(2, [
      { worktreeId: 'wt-1', branchName: 'feature/one', expectedHead: 'head-one' },
      { worktreeId: 'wt-2', branchName: 'feature/two', expectedHead: 'head-two' }
    ])
  })
})
