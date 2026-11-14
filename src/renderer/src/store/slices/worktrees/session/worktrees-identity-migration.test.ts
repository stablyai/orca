import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { resetHostedReviewLinkMutationGenerationForTests } from '../metadata/hosted-review-link-mutation'
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

describe('migrateWorktreeIdentity', () => {
  const OLD = 'repo1::/ws/cunner'
  const NEW = 'repo1::/ws/worktree-creation-spinner'

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetHostedReviewLinkMutationGenerationForTests()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('sanitizes lagging old-id worktree refresh rows after hosted review bookkeeping migrates', async () => {
    const store = createTestStore()
    const oldWorktree = makeWorktree({
      id: OLD,
      repoId: 'repo1',
      path: '/ws/cunner',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })

    store.setState({ worktreesByRepo: { repo1: [oldWorktree] } } as Partial<AppState>)
    store.getState().updateWorktreeGitIdentity(
      OLD,
      {
        head: 'new-head',
        branch: 'refs/heads/stack/two'
      },
      null
    )
    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: OLD,
        updates: expect.objectContaining({ linkedPR: null, pushTarget: undefined })
      })
    })

    const switched = store.getState().worktreesByRepo.repo1[0]
    store.setState({ worktreesByRepo: { repo1: [{ ...switched, id: NEW }] } } as Partial<AppState>)
    store.getState().migrateWorktreeIdentity(OLD, NEW)
    worktreeListMock.mockResolvedValue([
      {
        ...oldWorktree,
        head: 'old-head',
        linkedPR: 101,
        pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
      }
    ])

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      id: OLD,
      branch: 'refs/heads/stack/two',
      head: 'new-head',
      linkedPR: null,
      pushTarget: undefined
    })
  })

  it('persists a queued branch-switch clear when migration happens during the old-id write', async () => {
    const store = createTestStore()
    const oldWorktree = makeWorktree({
      id: OLD,
      repoId: 'repo1',
      path: '/ws/cunner',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      pushTarget: { remoteName: 'fork', branchName: 'old/review-head' }
    })
    let releaseOldPersist!: () => void
    let oldPersistStarted!: () => void
    const oldPersistReleased = new Promise<void>((resolve) => {
      releaseOldPersist = resolve
    })
    const oldPersistStartedPromise = new Promise<void>((resolve) => {
      oldPersistStarted = resolve
    })
    mockApi.worktrees.updateMeta.mockImplementation(async ({ worktreeId, updates }) => {
      if (worktreeId === OLD && updates.linkedPR === null) {
        oldPersistStarted()
        await oldPersistReleased
      }
    })

    store.setState({ worktreesByRepo: { repo1: [oldWorktree] } } as Partial<AppState>)
    store.getState().updateWorktreeGitIdentity(OLD, { branch: 'refs/heads/stack/two' }, null)
    await oldPersistStartedPromise
    const switched = store.getState().worktreesByRepo.repo1[0]
    store.setState({
      worktreesByRepo: {
        repo1: [
          {
            ...switched,
            id: NEW,
            path: '/ws/worktree-creation-spinner'
          }
        ]
      }
    } as Partial<AppState>)
    store.getState().migrateWorktreeIdentity(OLD, NEW)
    releaseOldPersist()

    await vi.waitFor(() => {
      expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
        worktreeId: NEW,
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
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      id: NEW,
      branch: 'refs/heads/stack/two',
      linkedPR: null,
      pushTarget: undefined
    })
  })
})
