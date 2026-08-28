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

  it('updates branch identity from git status without fetching worktrees', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/main'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 3 } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'new-head',
      branch: 'refs/heads/feature'
    })
    expect(store.getState().sortEpoch).toBe(4)
    expect(mockApi.worktrees.list).not.toHaveBeenCalled()
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
  })

  it('does not notify subscribers when git status reports unchanged identity', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/main'
    })
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 3 } as Partial<AppState>)
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'old-head',
      branch: 'refs/heads/main'
    })
    store.getState().updateWorktreeGitIdentity('repo1::/path/missing', {
      head: 'new-head',
      branch: 'refs/heads/feature'
    })

    unsubscribe()
    expect(notifications).toBe(0)
    expect(store.getState().sortEpoch).toBe(3)
  })

  it('clears branch-scoped linked reviews when git status observes a branch switch', () => {
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

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/two',
      linkedPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      pushTarget: undefined
    })
  })

  it('preserves linked reviews when branch identity only changes ref formatting', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'stack/one',
      linkedPR: 101,
      linkedGitLabMR: 102
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/stack/one'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      linkedGitLabMR: 102
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('preserves linked reviews when only the head commit changes', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      linkedGitLabMR: 102
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: 'refs/heads/stack/one'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'new-head',
      branch: 'refs/heads/stack/one',
      linkedPR: 101,
      linkedGitLabMR: 102
    })
  })

  it('follows the new branch in the title when displayName was auto-derived from the branch', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'feature'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0].displayName).toBe('main')
  })

  it('preserves a custom title when displayName differs from the branch', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'My Cool Work'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0].displayName).toBe('My Cool Work')
  })

  it('clears stale branch identity for detached HEAD updates', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/review-branch',
      displayName: 'Restore PR review'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 3 } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: null
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'new-head',
      branch: '',
      displayName: 'Restore PR review'
    })
    expect(store.getState().sortEpoch).toBe(4)
  })

  it('keeps an auto-derived title when detached HEAD clears the branch', () => {
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

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: null
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: '',
      displayName: 'review-branch'
    })
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

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'detached-head',
      branch: null
    })
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'reattached-head',
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/main',
      displayName: 'main'
    })
  })

  it('preserves custom detached titles when a branch returns', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'detached-head',
      branch: '',
      displayName: 'Restore PR review'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'reattached-head',
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/main',
      displayName: 'Restore PR review'
    })
  })
})
