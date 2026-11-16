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

  it('force-deletes a preserved HUB-owned SSH branch through its HUB', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo-ssh::/srv/nested-wt',
      repoId: 'repo-ssh',
      hostId: 'ssh:hub-private-target',
      runtimeOwnerEnvironmentId: 'owner-hub'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-force-delete-branch',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-owner-hub' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'different-hub' } as never,
      worktreesByRepo: { 'repo-ssh': [wt] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .forceDeletePreservedBranch(wt.id, 'feature/nested', 'abc123')

    expect(result).toEqual({ ok: true, deleted: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-hub',
      method: 'worktree.forceDeleteBranch',
      params: {
        worktree: `id:${wt.id}`,
        branchName: 'feature/nested',
        expectedHead: 'abc123'
      },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.forceDeletePreservedBranch).not.toHaveBeenCalled()
  })

  it('fails preserved branch deletion closed for two HUB owners', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-ssh::/srv/same-wt'
    store.setState({
      worktreesByRepo: {
        'repo-ssh': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-ssh',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-ssh',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-b'
          })
        ]
      }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .forceDeletePreservedBranch(worktreeId, 'feature/nested', 'abc123')

    expect(result).toEqual({
      ok: false,
      error: 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.forceDeletePreservedBranch).not.toHaveBeenCalled()
  })
})
