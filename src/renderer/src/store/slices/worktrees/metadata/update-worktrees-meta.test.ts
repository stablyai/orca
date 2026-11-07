import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import 'sonner'

import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
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

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('persists each batch metadata update to its workspace owner', async () => {
    const store = createTestStore()
    const first = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const second = makeWorktree({ id: 'repo1::/path/wt2', repoId: 'repo1', path: '/path/wt2' })
    store.setState({
      worktreesByRepo: { repo1: [first, second] },
      sortEpoch: 7
    } as Partial<AppState>)

    await store.getState().updateWorktreesMeta([
      { worktreeId: first.id, updates: { workspaceStatus: 'in-review' } },
      { worktreeId: second.id, updates: { workspaceStatus: 'completed' } }
    ])

    expect(store.getState().worktreesByRepo.repo1.map((w) => w.workspaceStatus)).toEqual([
      'in-review',
      'completed'
    ])
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: { workspaceStatus: 'in-review' }
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt2',
      updates: { workspaceStatus: 'completed' }
    })
  })

  it('persists a same-id manual rank to every owning host', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/same/path'
    const local = makeWorktree({ id: worktreeId, repoId: 'repo1', hostId: 'local' })
    const remote = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      hostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set-manual-order',
      ok: true,
      result: { worktree: { ...remote, manualOrder: 9000 } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ worktreesByRepo: { repo1: [local, remote] } } as Partial<AppState>)

    await store.getState().updateWorktreesMeta([{ worktreeId, updates: { manualOrder: 9000 } }])

    expect(store.getState().worktreesByRepo.repo1.map((row) => row.manualOrder)).toEqual([
      9000, 9000
    ])
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId,
      executionHostId: 'local',
      updates: { manualOrder: 9000 }
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: { worktree: `id:${worktreeId}`, manualOrder: 9000 },
      timeoutMs: 15_000
    })
  })
  it('persists an explicit bulk host update to only the selected owner', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/same/path'
    const local = makeWorktree({ id: worktreeId, repoId: 'repo1', hostId: 'local' })
    const remote = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      hostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set-selected-owner',
      ok: true,
      result: { worktree: { ...remote, comment: 'selected' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ worktreesByRepo: { repo1: [local, remote] } } as Partial<AppState>)

    await store
      .getState()
      .updateWorktreesMeta([
        { worktreeId, updates: { comment: 'selected' }, executionHostId: 'runtime:env-1' }
      ])

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      expect.objectContaining({ hostId: 'local', comment: '' }),
      expect.objectContaining({ hostId: 'runtime:env-1', comment: 'selected' })
    ])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'worktree.set',
        params: expect.objectContaining({ comment: 'selected' })
      })
    )
  })
})
