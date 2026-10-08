import { beforeEach, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

it.each([
  'remote',
  'account',
  'path',
  'removed',
  'instance',
  'head',
  'credentials',
  'label'
] as const)('rechecks %s before persisting delayed terminal confirmation', async (change) => {
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
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: vi.fn(() => pending.promise) }
  })
  store.setState({ repos: [repo], worktreesByRepo: { repo: [workspace] } })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, {
    number: 42,
    url: review.url,
    slug: { owner: 'acme', repo: 'orca' }
  })
  store.setState({
    repos:
      change === 'removed'
        ? []
        : [
            {
              ...repo,
              ...(change === 'remote'
                ? {
                    gitRemoteIdentity: {
                      ...repo.gitRemoteIdentity,
                      canonicalKey: 'github.com/other/repo',
                      remoteName: 'origin',
                      remoteUrl: 'https://github.com/other/repo.git'
                    }
                  }
                : {}),
              ...(change === 'account'
                ? { ghAccount: { host: 'github.com', user: 'another-user' } }
                : {}),
              ...(change === 'path' ? { path: '/replacement-repo' } : {}),
              ...(change === 'label' ? { displayName: 'Renamed' } : {})
            }
          ],
    worktreesByRepo: {
      repo: [
        {
          ...workspace,
          ...(change === 'head' ? { head: 'new-head' } : {}),
          ...(change === 'instance'
            ? {
                identity: {
                  key: 'wt2:local:replacement',
                  executionHostId: 'local' as const,
                  instanceId: 'replacement'
                }
              }
            : {})
        }
      ]
    }
  })
  if (change === 'credentials') {
    bumpProviderRuntimeSessionGeneration()
  }
  pending.resolve(review)
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
  if (change === 'label') {
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
  } else {
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBeNull()
  }
})
