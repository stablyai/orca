import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it("keeps a local card out of a paired host's own column but still applies its rank", async () => {
    const store = createTestStore()
    const local = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({
      worktreesByRepo: { repo1: [local] },
      workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
      hostWorkspaceStatuses: { 'env-1': [{ id: 'status-6', label: 'Today' }] }
    })

    await store
      .getState()
      .updateWorktreesMeta([
        { worktreeId: local.id, updates: { workspaceStatus: 'status-6', manualOrder: 5 } }
      ])
    await store.getState().updateWorktreeMeta(local.id, { workspaceStatus: 'status-6' })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({ manualOrder: 5 })
    expect(store.getState().worktreesByRepo.repo1[0]?.workspaceStatus).toBeUndefined()
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { manualOrder: 5 } })
    )
  })

  it("still moves a paired host's card into that host's own column", async () => {
    const store = createTestStore()
    const hosted = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      hostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set-status',
      ok: true,
      result: { worktree: { ...hosted, workspaceStatus: 'status-6' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      worktreesByRepo: { repo1: [hosted] },
      workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
      hostWorkspaceStatuses: { 'env-1': [{ id: 'status-6', label: 'Today' }] }
    })

    await store.getState().updateWorktreesMeta([
      {
        worktreeId: hosted.id,
        updates: { workspaceStatus: 'status-6' },
        executionHostId: 'runtime:env-1'
      }
    ])

    expect(store.getState().worktreesByRepo.repo1[0]?.workspaceStatus).toBe('status-6')
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        params: expect.objectContaining({ workspaceStatus: 'status-6' })
      })
    )
  })
})
