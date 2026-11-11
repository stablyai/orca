import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { resetHostedReviewLinkMutationGenerationForTests } from './hosted-review-link-mutation'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
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

describe('updateWorktreeGitIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetHostedReviewLinkMutationGenerationForTests()
  })

  it('preserves a clean refreshed head when a later stale linked row arrives', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101
    })
    const cleanHeadAdvance = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/two',
      head: 'newer-head',
      linkedPR: null,
      pushTarget: undefined
    })
    const staleLinkedRow = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/two',
      head: 'old-head',
      linkedPR: 101
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)
    store.getState().updateWorktreeGitIdentity(
      'repo1::/path/wt1',
      {
        head: 'new-head',
        branch: 'refs/heads/stack/two'
      },
      null
    )
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: expect.objectContaining({ linkedPR: null })
      })
    })

    worktreeListMock.mockResolvedValue([cleanHeadAdvance])
    await store.getState().fetchWorktrees('repo1')
    worktreeListMock.mockResolvedValue([staleLinkedRow])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/two',
      head: 'newer-head',
      linkedPR: null
    })
  })

  it('allows a clean worktree refresh to observe a later branch after stale-refetch protection', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101
    })
    const laterBranch = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/three',
      linkedPR: null,
      pushTarget: undefined
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)
    store.getState().updateWorktreeGitIdentity(
      'repo1::/path/wt1',
      {
        branch: 'refs/heads/stack/two'
      },
      null
    )
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: expect.objectContaining({ linkedPR: null })
      })
    })

    worktreeListMock.mockResolvedValue([laterBranch])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/three',
      linkedPR: null,
      pushTarget: undefined
    })

    worktreeListMock.mockResolvedValue([
      {
        ...existing,
        linkedPR: 101,
        pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
      }
    ])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/three',
      linkedPR: null,
      pushTarget: undefined
    })
  })
})
