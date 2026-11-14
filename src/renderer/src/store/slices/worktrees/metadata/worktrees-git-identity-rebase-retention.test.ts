import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
} from '../worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

const id = 'repo1::/path/wt1'
const review = {
  provider: 'github' as const,
  type: 'pr' as const,
  number: 37557,
  title: 'Review',
  url: 'https://github.com/stablyai/orca/pull/37557'
}

function linkedWorktree() {
  return makeWorktree({
    id,
    repoId: 'repo1',
    path: '/path/wt1',
    instanceId: 'local-instance',
    linkedPR: 37557,
    linkedWorkItem: review,
    linkedItems: [review],
    pushTarget: { remoteName: 'fork', branchName: 'feature' }
  })
}

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

describe('review retention across detached HEAD', () => {
  it('preserves a rebase return, then clears on a listing-confirmed switch without affecting a remote twin', async () => {
    const local = linkedWorktree()
    const remote = { ...local, hostId: 'ssh:box-b' as const, instanceId: 'remote-instance' }
    const store = createTestStore()
    store.setState({ worktreesByRepo: { repo1: [local, remote] } })

    store.getState().updateWorktreeGitIdentity(id, { branch: null }, 'local')
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: '',
      linkedPR: 37557,
      pushTarget: { remoteName: 'fork', branchName: 'feature' }
    })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/feature' }, 'local')
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: 37557,
      pushTarget: { remoteName: 'fork', branchName: 'feature' }
    })

    store.getState().updateWorktreeGitIdentity(id, { branch: null }, 'local')
    worktreeListMock.mockResolvedValue([{ ...local, branch: 'refs/heads/other' }])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/other',
      linkedPR: null,
      pushTarget: undefined,
      linkedItems: [expect.objectContaining({ number: 37557 })]
    })
    expect(store.getState().worktreesByRepo.repo1[1]).toEqual(remote)
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: id,
          updates: expect.objectContaining({ linkedPR: null, pushTarget: undefined })
        })
      )
    })
  })

  it('preserves associations when first opened detached without a known owning branch', () => {
    const store = createTestStore()
    store.setState({ worktreesByRepo: { repo1: [{ ...linkedWorktree(), branch: '' }] } })

    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/other' }, null)

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: 37557,
      pushTarget: { remoteName: 'fork', branchName: 'feature' }
    })
  })

  it('preserves a newer review while rejecting a stale push target during its pending clear', async () => {
    const local = linkedWorktree()
    const store = createTestStore()
    store.setState({ worktreesByRepo: { repo1: [local] } })
    store.getState().updateWorktreeGitIdentity(id, { branch: null }, null)
    const relinked = {
      ...local,
      branch: '',
      linkedWorkItem: { ...review, url: 'https://github.com/other/project/pull/37557' }
    }
    worktreeListMock.mockResolvedValue([relinked])
    await store.getState().fetchWorktrees('repo1')
    const pending = Promise.withResolvers<void>()
    mockApi.worktrees.updateMeta.mockImplementationOnce(() => pending.promise)

    try {
      store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/other' }, null)
      worktreeListMock.mockResolvedValue([{ ...relinked, branch: 'refs/heads/other' }])
      await store.getState().fetchWorktrees('repo1')

      expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
        branch: 'refs/heads/other',
        linkedPR: 37557,
        linkedWorkItem: { url: 'https://github.com/other/project/pull/37557' },
        pushTarget: undefined
      })
    } finally {
      pending.resolve()
    }
  })
})
