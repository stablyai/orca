import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { resetHostedReviewLinkMutationGenerationForTests } from './hosted-review-link-mutation'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
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

  it('resumes following branch names after an auto-derived title crosses detached HEAD', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/review-branch',
      displayName: 'review-branch'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity(
      'repo1::/path/wt1',
      {
        head: 'detached-head',
        branch: null
      },
      null
    )
    store.getState().updateWorktreeGitIdentity(
      'repo1::/path/wt1',
      {
        head: 'reattached-head',
        branch: 'refs/heads/main'
      },
      null
    )

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/main',
      displayName: 'main'
    })
  })
})
