vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Repo } from '../../../../../../shared/repo-types'
import { bumpProviderRuntimeSessionGeneration } from '@/runtime/hosts/observations/provider-runtime-context'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  Object.defineProperty(window.api, 'gh', {
    configurable: true,
    value: { workItemByOwnerRepo: vi.fn().mockResolvedValue(null) }
  })
  resetWorktreeSliceModuleMemory()
})

it('rejects delayed terminal confirmation after remote identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({
    repos: [
      {
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/other/repo',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/other/repo.git'
        }
      }
    ],
    worktreesByRepo: { repo: [workspace] }
  })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('rejects delayed terminal confirmation after account identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({
    repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'another-user' } }],
    worktreesByRepo: { repo: [workspace] }
  })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('rejects delayed terminal confirmation after path identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({
    repos: [{ ...repo, path: '/replacement-repo' }],
    worktreesByRepo: { repo: [workspace] }
  })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('rejects delayed terminal confirmation after removed identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({ repos: [], worktreesByRepo: { repo: [workspace] } })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('rejects delayed terminal confirmation after instance identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({
    repos: [repo],
    worktreesByRepo: {
      repo: [
        {
          ...workspace,
          identity: {
            key: 'wt2:local:replacement',
            executionHostId: 'local' as const,
            instanceId: 'replacement'
          }
        }
      ]
    }
  })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('rejects delayed terminal confirmation after head identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({ repos: [repo], worktreesByRepo: { repo: [{ ...workspace, head: 'new-head' }] } })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('rejects delayed terminal confirmation after credentials identity changes', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  bumpProviderRuntimeSessionGeneration()
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
})

it('keeps delayed review confirmation after a cosmetic repo rename', async () => {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Orca',
    addedAt: 0,
    badgeColor: '',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/orca',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/orca.git'
    }
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    url: 'https://github.com/acme/orca/pull/42',
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const pending = Promise.withResolvers<HostedReviewInfo | null>()
  const branchLookup = vi.fn(() => pending.promise)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  await vi.dynamicImportSettled()
  expect(branchLookup).toHaveBeenCalledTimes(1)
  store.setState({
    repos: [{ ...repo, displayName: 'Renamed' }],
    worktreesByRepo: { repo: [workspace] }
  })
  pending.resolve(review)
  await vi.dynamicImportSettled()
  expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBe(42)
})
