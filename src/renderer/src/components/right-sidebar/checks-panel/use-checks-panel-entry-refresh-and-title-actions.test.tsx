// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { _clearHostedReviewRequestGenerationsForTest } from '@/store/slices/hosted-review-request-state'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { isGitLabChecksPanelReview } from './gitlab-review-client'
import { useChecksPanelEntryRefreshAndTitleActions } from './use-checks-panel-entry-refresh-and-title-actions'

type EntryRefreshInput = Parameters<typeof useChecksPanelEntryRefreshAndTitleActions>[0]

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const gitLabReview: HostedReviewInfo = {
  provider: 'gitlab',
  number: 7,
  title: 'MR',
  url: 'https://gitlab.example.test/g/p/-/merge_requests/7',
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE',
  updatedAt: '2026-10-30'
}
const bitbucketReview: HostedReviewInfo = {
  provider: 'bitbucket',
  number: 12,
  title: 'PR',
  url: 'https://bitbucket.example.test/w/r/pull-requests/12',
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE',
  updatedAt: '2026-10-30'
}
const original = useAppStore.getState()

function makeInput(review: HostedReviewInfo): EntryRefreshInput {
  return {
    activeGitLabReview: isGitLabChecksPanelReview(review) ? review : null,
    activeReview: review,
    activeWorktree: makeWorktree({ id: 'worktree-1', repoId: repo.id }),
    activeWorktreeId: 'worktree-1',
    branch: 'main',
    checksFetchedAt: undefined,
    clearTitleInputFocusTimer: vi.fn(),
    commentsFetchedAt: undefined,
    enqueueGitHubPRRefresh: vi.fn(),
    fallbackGitHubPRNumber: null,
    fetchChecks: vi.fn(),
    fetchComments: vi.fn(),
    fetchGitLabDetails: vi.fn(async () => {}),
    fetchHostedReviewForBranch: useAppStore.getState().fetchHostedReviewForBranch,
    fetchPRForBranch: vi.fn(async () => null),
    hostedReviewCacheKey: 'hosted-review-key',
    isFolder: false,
    isGitLabReviewContext: review.provider === 'gitlab',
    // Hidden, so the tab-entry refresh stays out of the way.
    isPanelVisible: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: review.provider === 'bitbucket' ? review.number : null,
    linkedGiteaPR: null,
    linkedGitLabMR: review.provider === 'gitlab' ? review.number : null,
    linkedPR: null,
    mountedRef: { current: true },
    pollIntervalRef: { current: 30_000 },
    pr: null,
    prCacheKey: 'cache',
    prFetchedAt: undefined,
    prNumber: null,
    prevChecksRef: { current: '' },
    repo,
    setEditingTitle: vi.fn(),
    setTitleDraft: vi.fn(),
    setTitleSaving: vi.fn(),
    titleDraft: '',
    titleInputFocusTimerRef: { current: null },
    titleInputRef: { current: null }
  }
}

afterEach(() => {
  _clearHostedReviewRequestGenerationsForTest()
  useAppStore.setState(original)
  vi.unstubAllGlobals()
})

describe('refreshHostedReviewAfterMutation', () => {
  // Issue #14377: after Orca merges, the card must not keep the Open answer of a poll started before the merge.
  it.each([gitLabReview, bitbucketReview])(
    '$provider: reads after the write instead of joining an older poll, and a failed read is not a failed merge',
    async (review) => {
      const merged: HostedReviewInfo = { ...review, state: 'merged' }
      const olderPoll = Promise.withResolvers<HostedReviewInfo | null>()
      const forBranch = vi
        .fn()
        .mockReturnValueOnce(olderPoll.promise)
        .mockResolvedValueOnce(merged)
        .mockRejectedValueOnce(new Error('offline'))
      vi.stubGlobal('api', { hostedReview: { forBranch } })
      useAppStore.setState({ repos: [repo], hostedReviewCache: {} })
      const input = makeInput(review)
      // The same card read the follow-up used to make, started before the merge landed.
      const poll = refreshHostedReviewCard(input.fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch: 'main',
        linkedGitLabMR: input.linkedGitLabMR,
        linkedBitbucketPR: input.linkedBitbucketPR
      })
      const { result } = renderHook(() => useChecksPanelEntryRefreshAndTitleActions(input))

      await act(async () => result.current.refreshHostedReviewAfterMutation())

      expect(forBranch).toHaveBeenCalledTimes(2)
      expect(forBranch).toHaveBeenLastCalledWith(expect.objectContaining({ userRefresh: true }))
      olderPoll.resolve(review)
      await act(async () => void (await poll))
      expect(Object.values(useAppStore.getState().hostedReviewCache)[0]?.data?.state).toBe('merged')
      if (review.provider === 'gitlab') {
        expect(input.fetchGitLabDetails).toHaveBeenCalledWith(
          expect.objectContaining({ mrNumberOverride: review.number })
        )
      } else {
        expect(input.fetchPRForBranch).toHaveBeenCalledTimes(1)
      }

      // The merge action treats a rejection here as its own failure.
      await act(async () =>
        expect(result.current.refreshHostedReviewAfterMutation()).resolves.toBeUndefined()
      )
      expect(forBranch).toHaveBeenCalledTimes(3)
    }
  )
})

it('GitHub post-write refresh cannot reuse a pre-write PR read', async () => {
  const pr = (state: PRInfo['state'], headSha: string): PRInfo => ({
    number: 12,
    title: 'PR',
    state,
    url: 'https://github.com/acme/widgets/pull/12',
    checksStatus: 'success',
    updatedAt: '2026-10-30T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha
  })
  const old = Promise.withResolvers<{ kind: 'found'; pr: PRInfo; fetchedAt: number }>()
  const afterWrite = pr('merged', 'head-b')
  const refreshPRNow = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ kind: 'found', pr: afterWrite, fetchedAt: 2 })
  vi.stubGlobal('api', { gh: { refreshPRNow } })
  useAppStore.setState({ repos: [repo], prCache: {}, hostedReviewCache: {}, prRefreshStates: {} })
  const input = makeInput({ ...bitbucketReview, provider: 'github', state: 'merged' })
  input.fetchHostedReviewForBranch = vi.fn(async () => null)
  input.fetchPRForBranch = useAppStore.getState().fetchPRForBranch
  const before = input.fetchPRForBranch(repo.path, 'main', {
    force: true,
    repoId: repo.id,
    reason: 'visible'
  })
  const { result } = renderHook(() => useChecksPanelEntryRefreshAndTitleActions(input))
  await act(async () => result.current.refreshHostedReviewAfterMutation())
  old.resolve({ kind: 'found', pr: pr('open', 'head-a'), fetchedAt: 1 })
  await before
  const key = getGitHubPRCacheKey(repo.path, repo.id, 'main')
  expect(refreshPRNow).toHaveBeenCalledTimes(2)
  expect(refreshPRNow).toHaveBeenLastCalledWith(expect.objectContaining({ userRefresh: true }))
  expect(useAppStore.getState().prCache[key]?.data).toEqual(afterWrite)
})
