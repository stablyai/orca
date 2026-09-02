import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
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

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('waits for branch confirmation before linking a terminal PR URL for a known push target', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(fetchPRForBranch).toHaveBeenCalledWith('/repos/orca', 'feature/pr-link', {
      force: true,
      repoId: 'repo1',
      worktreeId: wt.id,
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: 'explicit',
      reason: 'active'
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: { linkedPR: 42, suppressedGitHubPR: null }
    })
  })

  it('ignores a terminal URL matching current GitHub PR suppression', () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(fetchPRForBranch).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('allows terminal observation of a different PR than the suppressed one', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 43 })
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/43',
      slug: { owner: 'acme', repo: 'orca' },
      number: 43
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: { linkedPR: 43, suppressedGitHubPR: null }
    })
  })

  it('rechecks GitHub PR suppression after branch confirmation resolves', async () => {
    const store = createTestStore()
    let resolveLookup: (value: { number: number } | null) => void = () => {}
    const fetchPRForBranch = vi.fn(
      () =>
        new Promise<{ number: number } | null>((resolve) => {
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })
    store.setState({
      worktreesByRepo: {
        repo1: [{ ...wt, linkedPR: null, suppressedGitHubPR: 42 }]
      }
    } as Partial<AppState>)

    resolveLookup({ number: 42 })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('waits for branch confirmation before linking a same-repo terminal PR URL', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(fetchPRForBranch).toHaveBeenCalledWith('/repos/orca', 'feature/pr-link', {
      force: true,
      repoId: 'repo1',
      worktreeId: wt.id,
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: 'explicit',
      reason: 'active'
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: { linkedPR: 42, suppressedGitHubPR: null }
    })
  })

  it('does not persist a terminal PR URL when the linked PR changes before branch confirmation resolves', async () => {
    const store = createTestStore()
    let resolveLookup: (value: { number: number } | null) => void = () => {}
    const fetchPRForBranch = vi.fn(
      () =>
        new Promise<{ number: number } | null>((resolve) => {
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    } as Partial<AppState>)

    resolveLookup({ number: 42 })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('does not persist a terminal PR URL when the linked PR changes while push target lookup resolves', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 42
    })

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    } as Partial<AppState>)

    resolvePushTarget({
      baseBranch: 'main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/pr-link' }
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('does not link an arbitrary same-repo terminal PR URL for a known push target when lookup misses', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue(null)
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/1',
      slug: { owner: 'acme', repo: 'orca' },
      number: 1
    })

    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 1 }
    })
  })

  it('uses branch confirmation before linking a differently named terminal PR URL', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
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
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/docs/pull/42',
      slug: { owner: 'acme', repo: 'docs' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(fetchPRForBranch).toHaveBeenCalledWith('/repos/orca', 'feature/pr-link', {
      force: true,
      repoId: 'repo1',
      worktreeId: wt.id,
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: 'explicit',
      reason: 'active'
    })

    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: { linkedPR: 42, suppressedGitHubPR: null }
    })
  })
})
