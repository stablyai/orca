import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo, HostedReviewForBranchArgs } from '../../../../shared/hosted-review'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

function installReviewRead() {
  const read = vi.fn<(args: HostedReviewForBranchArgs) => Promise<HostedReviewInfo | null>>()
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: read }
  })
  return read
}

const confirmedReview = (number: number): HostedReviewInfo => ({
  provider: 'github',
  number,
  title: 'Confirmed',
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE',
  url: `https://github.com/acme/orca/pull/${number}`,
  updatedAt: '2026-01-01'
})

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

  it('waits for branch confirmation before linking a terminal PR URL for a known push target', async () => {
    const store = createTestStore()
    const readHostedReview = installReviewRead().mockResolvedValue(confirmedReview(42))
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link',
        remoteUrl: 'https://github.com/acme/orca.git'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(readHostedReview).toHaveBeenCalled())
    expect(readHostedReview).toHaveBeenCalledWith({
      repoPath: '/repos/orca',
      branch: 'feature/pr-link',
      force: true,
      repoId: 'repo1',
      active: true,
      repoOwnerExecutionHostId: 'local',
      currentHeadOid: wt.head,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: expect.objectContaining({
        linkedItems: [{ provider: 'github', type: 'pr', number: 42 }],
        linkedPR: 42,
        suppressedGitHubPR: null
      })
    })
  })

  it('ignores a terminal URL matching current GitHub PR suppression', () => {
    const store = createTestStore()
    const readHostedReview = installReviewRead().mockResolvedValue(confirmedReview(42))
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      linkedPR: null,
      suppressedGitHubPR: 42
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(readHostedReview).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('allows terminal observation of a different PR than the suppressed one', async () => {
    const store = createTestStore()
    installReviewRead().mockResolvedValue(confirmedReview(43))
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      linkedPR: null,
      suppressedGitHubPR: 42,
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/43',
      slug: { owner: 'acme', repo: 'orca' },
      number: 43
    })
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: expect.objectContaining({
        linkedItems: [{ provider: 'github', type: 'pr', number: 43 }],
        linkedPR: 43,
        suppressedGitHubPR: null
      })
    })
  })

  it('rechecks GitHub PR suppression after branch confirmation resolves', async () => {
    const store = createTestStore()
    let resolveLookup: (value: HostedReviewInfo | null) => void = () => {}
    installReviewRead().mockImplementation(
      () =>
        new Promise<HostedReviewInfo | null>((resolve) => {
          resolveLookup = resolve
        })
    )
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      linkedPR: null,
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
    store.setState({
      worktreesByRepo: {
        repo1: [{ ...wt, linkedPR: null, suppressedGitHubPR: 42 }]
      }
    })

    resolveLookup(confirmedReview(42))
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('waits for branch confirmation before linking a same-repo terminal PR URL', async () => {
    const store = createTestStore()
    const readHostedReview = installReviewRead().mockResolvedValue(confirmedReview(42))
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    await vi.waitFor(() => expect(readHostedReview).toHaveBeenCalled())
    expect(readHostedReview).toHaveBeenCalledWith({
      repoPath: '/repos/orca',
      branch: 'feature/pr-link',
      force: true,
      repoId: 'repo1',
      active: true,
      repoOwnerExecutionHostId: 'local',
      currentHeadOid: wt.head,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: expect.objectContaining({
        linkedItems: [{ provider: 'github', type: 'pr', number: 42 }],
        linkedPR: 42,
        suppressedGitHubPR: null
      })
    })
  })

  it('preserves a manual primary while appending a PR confirmed after the selection changes', async () => {
    const store = createTestStore()
    let resolveLookup: (value: HostedReviewInfo | null) => void = () => {}
    installReviewRead().mockImplementation(
      () =>
        new Promise<HostedReviewInfo | null>((resolve) => {
          resolveLookup = resolve
        })
    )
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    })

    resolveLookup(confirmedReview(42))
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(
      getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0]).map((item) => item.number)
    ).toEqual([7, 42])
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
  })

  it('appends a confirmed PR without overwriting a primary changed during push target lookup', async () => {
    const store = createTestStore()
    installReviewRead().mockResolvedValue(confirmedReview(42))
    let resolvePushTarget: (value: {
      baseBranch: string
      pushTarget: { remoteName: string; branchName: string }
    }) => void = () => {}
    mockApi.worktrees.resolvePrBase.mockImplementationOnce(
      () =>
        new Promise<{
          baseBranch: string
          pushTarget: { remoteName: string; branchName: string }
        }>((resolve) => {
          resolvePushTarget = resolve
        })
    )
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link'
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 42
    })

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    })

    resolvePushTarget({
      baseBranch: 'main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/pr-link' }
    })
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(
      getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0]).map((item) => item.number)
    ).toEqual([7, 42])
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
  })

  it('does not link an arbitrary same-repo terminal PR URL for a known push target when lookup misses', async () => {
    const store = createTestStore()
    installReviewRead().mockResolvedValue(null)
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link',
        remoteUrl: 'https://github.com/acme/orca.git'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/1',
      slug: { owner: 'acme', repo: 'orca' },
      number: 1
    })

    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 1 }
    })
  })

  it('rejects a same-number branch result for a different repository URL', async () => {
    const store = createTestStore()
    const readHostedReview = installReviewRead().mockResolvedValue(confirmedReview(42))
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link'
    })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({ baseBranch: 'main' })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/docs/pull/42',
      slug: { owner: 'acme', repo: 'docs' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    await vi.waitFor(() => expect(readHostedReview).toHaveBeenCalled())
    expect(readHostedReview).toHaveBeenCalledWith({
      repoPath: '/repos/orca',
      branch: 'feature/pr-link',
      force: true,
      repoId: 'repo1',
      active: true,
      repoOwnerExecutionHostId: 'local',
      currentHeadOid: wt.head,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })

    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})
