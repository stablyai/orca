import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { resetHostedReviewLinkMutationGenerationForTests } from './worktrees'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

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

  it('persists cleared branch-scoped linked reviews when git status observes a branch switch', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      linkedGitLabMR: 102,
      linkedBitbucketPR: 103,
      linkedAzureDevOpsPR: 104,
      linkedGiteaPR: 105,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await Promise.resolve()

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: {
        linkedPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null,
        pushTarget: undefined
      }
    })
  })

  it('persists cleared branch-scoped push target when git status observes a branch switch', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await Promise.resolve()

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/two',
      pushTarget: undefined
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: {
        linkedPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null,
        pushTarget: undefined
      }
    })
  })

  it('does not persist a delayed branch-switch clear over a newer manual relink', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101
    })
    let resolveClearPersist!: () => void
    const clearPersisted = new Promise<void>((resolve) => {
      resolveClearPersist = resolve
    })
    mockApi.worktrees.updateMeta.mockImplementation(async ({ updates }) => {
      if (
        updates.linkedPR === null &&
        updates.linkedGitLabMR === null &&
        updates.linkedBitbucketPR === null &&
        updates.linkedAzureDevOpsPR === null &&
        updates.linkedGiteaPR === null
      ) {
        await clearPersisted
      }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await Promise.resolve()
    await store.getState().updateWorktreeMeta('repo1::/path/wt1', { linkedGitLabMR: 202 })
    resolveClearPersist()

    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenLastCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: {
          linkedPR: null,
          linkedGitLabMR: 202,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null,
          pushTarget: undefined
        }
      })
    })
  })

  it('does not persist a delayed branch-switch clear over a newer push target update', async () => {
    const store = createTestStore()
    const nextPushTarget = { remoteName: 'fork', branchName: 'next/review-head' }
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })
    let resolveClearPersist!: () => void
    const clearPersisted = new Promise<void>((resolve) => {
      resolveClearPersist = resolve
    })
    mockApi.worktrees.updateMeta.mockImplementation(async ({ updates }) => {
      if (
        updates.linkedPR === null &&
        updates.pushTarget === undefined &&
        updates.linkedGitLabMR === null
      ) {
        await clearPersisted
      }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await Promise.resolve()
    await store.getState().updateWorktreeMeta('repo1::/path/wt1', { pushTarget: nextPushTarget })
    resolveClearPersist()

    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenLastCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: {
          linkedPR: null,
          linkedGitLabMR: null,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null,
          pushTarget: nextPushTarget
        }
      })
    })
  })

  it('persists a clear when the branch switches again before the first clear write finishes', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })
    let releaseFirstClear!: () => void
    const firstClearReleased = new Promise<void>((resolve) => {
      releaseFirstClear = resolve
    })
    let clearCalls = 0
    mockApi.worktrees.updateMeta.mockImplementation(async ({ updates }) => {
      if (updates.linkedPR === null && updates.pushTarget === undefined) {
        clearCalls += 1
        if (clearCalls === 1) {
          await firstClearReleased
        }
      }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await Promise.resolve()
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/three'
    })
    releaseFirstClear()

    await vi.waitFor(() => {
      expect(clearCalls).toBeGreaterThanOrEqual(2)
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenLastCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: {
        linkedPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null,
        pushTarget: undefined
      }
    })
  })

  it('clears stale linked reviews rehydrated by a refetch while branch-switch clear persists', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })
    let resolveClearPersist!: () => void
    const clearPersisted = new Promise<void>((resolve) => {
      resolveClearPersist = resolve
    })
    mockApi.worktrees.updateMeta.mockImplementation(async ({ updates }) => {
      if (updates.linkedPR === null) {
        await clearPersisted
      }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await Promise.resolve()
    const switched = store.getState().worktreesByRepo.repo1[0]
    store.setState({
      worktreesByRepo: {
        repo1: [
          {
            ...switched,
            linkedPR: 101,
            pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
          }
        ]
      }
    } as Partial<AppState>)
    resolveClearPersist()

    await vi.waitFor(() => {
      expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
        branch: 'refs/heads/stack/two',
        linkedPR: null,
        pushTarget: undefined
      })
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: {
        linkedPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null,
        pushTarget: undefined
      }
    })
  })

  it('clears stale linked reviews rehydrated before branch-switch clear starts persisting', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    const switched = store.getState().worktreesByRepo.repo1[0]
    store.setState({
      worktreesByRepo: {
        repo1: [
          {
            ...switched,
            linkedPR: 101,
            pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
          }
        ]
      }
    } as Partial<AppState>)

    await vi.waitFor(() => {
      expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
        branch: 'refs/heads/stack/two',
        linkedPR: null,
        pushTarget: undefined
      })
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: {
        linkedPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null,
        pushTarget: undefined
      }
    })
  })

  it('clears stale linked reviews rehydrated by a late worktree refetch after clear persists', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })
    const staleRefetch = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/stack/one',
      head: 'old-head',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: 'refs/heads/stack/two'
    })
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: {
          linkedPR: null,
          linkedGitLabMR: null,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null,
          pushTarget: undefined
        }
      })
    })

    mockApi.worktrees.list.mockResolvedValue([staleRefetch])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/two',
      head: 'new-head',
      linkedPR: null,
      pushTarget: undefined
    })
  })

  it('keeps stale linked reviews cleared after a later observed branch switch', async () => {
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
      branch: 'refs/heads/stack/one',
      linkedPR: 101
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: expect.objectContaining({ linkedPR: null })
      })
    })

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/one'
    })
    mockApi.worktrees.list.mockResolvedValue([laterBranch])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/one',
      linkedPR: null
    })
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
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: 'refs/heads/stack/two'
    })
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: expect.objectContaining({ linkedPR: null })
      })
    })

    mockApi.worktrees.list.mockResolvedValue([cleanHeadAdvance])
    await store.getState().fetchWorktrees('repo1')
    mockApi.worktrees.list.mockResolvedValue([staleLinkedRow])
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
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/two'
    })
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: 'repo1::/path/wt1',
        updates: expect.objectContaining({ linkedPR: null })
      })
    })

    mockApi.worktrees.list.mockResolvedValue([laterBranch])
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/three',
      linkedPR: null,
      pushTarget: undefined
    })

    mockApi.worktrees.list.mockResolvedValue([
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
