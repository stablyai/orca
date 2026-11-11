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

vi.mock('@/store/slices/worktrees/listing/worktree-catalog-index', () => ({
  getIndexedAllWorktrees: () => mocks.state.worktreeRows,
  getIndexedWorktreeMap: () => mocks.state.worktreeMap
}))
vi.mock('@/store/workspaces/selection/worktree-on-host-selector', () => ({
  // Match declared hosts even though this fixture indexes worktrees by ID.
  getWorktreeOnHostFromState: (_state: unknown, worktreeId: string, hostId?: string) => {
    const rows = mocks.state.worktreeRows.filter(
      (row) => (row as { id?: string }).id === worktreeId
    ) as { hostId?: string }[]
    return hostId ? rows.find((row) => row.hostId === hostId) : rows[0]
  }
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
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
import './delete-worktree-flow'
import { runWorktreeDeletesInParallel } from './worktree-delete-execution'
import { showPreservedBranchBatchToast } from './preserved-branch-batch-toast'

function runDeletesForCurrentWorktrees(
  targets: Parameters<typeof runWorktreeDeletesInParallel>[0],
  options?: Parameters<typeof runWorktreeDeletesInParallel>[1]
) {
  mocks.state.worktreeRows = [...targets]
  mocks.state.worktreeMap = new Map(targets.map((target) => [target.id, target]))
  return runWorktreeDeletesInParallel(targets, options)
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
        { id: 'child', displayName: 'child', repoId: 'repo-b', path: '/workspaces/parent/child' }
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
})
