// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
import { selectChecksPanelReview } from '../checks-panel-review'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { isStaleMergedGitHubReviewForHead } from '@/store/slices/hosted-review-cache-state'
import { mapGitHubReview } from '../../../../../main/source-control/forge-review-mappers'
import { useChecksPanelGitHubReviewHydration } from './use-checks-panel-github-review-hydration'

type HydrationInput = Parameters<typeof useChecksPanelGitHubReviewHydration>[0]
const original = useAppStore.getState()
const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const githubReview: HostedReviewInfo = {
  provider: 'github',
  number: 12,
  title: 'PR',
  url: 'https://github.com/acme/widgets/pull/12',
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE',
  updatedAt: '2026-10-30'
}
function makeInput(review: HostedReviewInfo): HydrationInput {
  return {
    activeWorktree: null,
    activeWorktreeId: 'worktree-1',
    branch: 'main',
    fetchPRForBranch: vi.fn(async () => null),
    hostedReview: review,
    hostedReviewCacheKey: 'hosted-review-key',
    hostedReviewCreation: null,
    hostedReviewCreationSnapshot: null,
    isFolder: false,
    isPanelVisible: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: review.provider === 'bitbucket' ? review.number : null,
    linkedGiteaPR: null,
    linkedGitLabMR: review.provider === 'gitlab' ? review.number : null,
    linkedPR: null,
    pr: null,
    prCacheKey: 'cache',
    prRefreshState: undefined,
    repo
  }
}

afterEach(() => {
  cleanup()
  useAppStore.setState(original)
  vi.unstubAllGlobals()
})
describe('loading known GitHub reviews', () => {
  it.each([
    ['eligibility', 'older-miss'],
    ['hosted-review', 'older-miss'],
    ['eligibility', 'newer-miss'],
    ['hosted-review', 'newer-miss'],
    ['eligibility', 'older-merged'],
    ['hosted-review', 'older-merged'],
    ['eligibility', 'newer-merged'],
    ['hosted-review', 'newer-merged']
  ] as const)(
    'reuses complete %s results without overwriting a newer cache entry: %s',
    async (source, cachedResult) => {
      const newerCache = cachedResult.startsWith('newer')
      const found: PRInfo = {
        number: 12,
        title: 'Original lookup result',
        state: 'open',
        url: 'https://github.example.test/acme/widgets/pull/12',
        checksStatus: 'success',
        updatedAt: '2026-10-30T00:00:00Z',
        mergeable: 'MERGEABLE',
        headSha: 'head-a',
        headRepo: { owner: 'contributor', repo: 'fork' },
        prRepo: { owner: 'acme', repo: 'widgets', host: 'github.example.test' },
        headRefName: 'feature/original',
        baseRefName: 'main',
        mergeMethodSettings: {
          defaultMethod: 'squash',
          allowedMethods: { merge: false, squash: true, rebase: false }
        }
      }
      const review = mapGitHubReview(found)
      const refreshPRNow = vi.fn(async () => {
        throw new Error('Unnecessary lookup')
      })
      vi.stubGlobal('api', { gh: { refreshPRNow } })
      const key = getGitHubPRCacheKey(repo.path, repo.id, 'main')
      const hostedKey = getHostedReviewCacheKey(
        repo.path,
        'main',
        original.settings,
        repo.id,
        undefined,
        undefined,
        true
      )
      const cachedEntry = {
        data: cachedResult.endsWith('merged')
          ? { ...found, number: 11, state: 'merged' as const, headSha: 'previous-head' }
          : null,
        fetchedAt: newerCache ? 3 : 1
      }
      useAppStore.setState({
        repos: [repo],
        prCache: { [key]: cachedEntry },
        hostedReviewCache:
          source === 'hosted-review' ? { [hostedKey]: { data: review, fetchedAt: 2 } } : {},
        prRefreshStates: {}
      })
      const input = makeInput(review)
      input.activeWorktree = {
        id: 'worktree-1',
        repoId: repo.id,
        path: repo.path,
        displayName: 'main',
        comment: '',
        linkedIssue: null,
        linkedPR: found.number,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        branch: 'main',
        head: 'head-a',
        isBare: false,
        isMainWorktree: true
      }
      input.prCacheKey = key
      input.hostedReviewCacheKey = hostedKey
      input.hostedReview = source === 'hosted-review' ? review : null
      input.isPanelVisible = true
      input.linkedPR = found.number
      input.fetchPRForBranch = useAppStore.getState().fetchPRForBranch
      if (source === 'eligibility') {
        input.hostedReviewCreation = {
          provider: 'github',
          review: { number: found.number, url: found.url },
          githubPullRequest: review.githubPullRequest,
          canCreate: false,
          blockedReason: 'existing_review',
          nextAction: 'open_existing_review',
          reviewLookupOutcome: 'found'
        }
        input.hostedReviewCreationSnapshot = {
          requestKey: 'request',
          contextKey: 'context',
          repoId: repo.id,
          worktreeId: input.activeWorktreeId,
          branch: input.branch,
          requestStartedAt: 1,
          completedAt: 2,
          gitFingerprint: 'git',
          data: input.hostedReviewCreation
        }
      }
      const { result, rerender } = renderHook(
        ({ ready }) => {
          const entry = useAppStore((s) => s.prCache[key])
          const pr = isStaleMergedGitHubReviewForHead(entry, input.activeWorktree?.head)
            ? null
            : (entry?.data ?? null)
          const model = {
            ...input,
            pr,
            hostedReview: ready ? input.hostedReview : null,
            hostedReviewCreation: ready ? input.hostedReviewCreation : null
          }
          useChecksPanelGitHubReviewHydration(model)
          return selectChecksPanelReview({ ...model, suppressedGitHubPR: null })
        },
        { initialProps: { ready: false } }
      )
      expect(result.current).toBeNull()
      expect(refreshPRNow).not.toHaveBeenCalled()
      await act(async () => rerender({ ready: true }))
      if (newerCache) {
        expect(result.current).toBeNull()
        expect(useAppStore.getState().prCache[key]).toEqual(cachedEntry)
      } else {
        expect(result.current).toMatchObject({ title: found.title, number: 12, status: 'success' })
        expect(useAppStore.getState().prCache[key]?.data).toEqual(found)
      }
      expect(refreshPRNow).not.toHaveBeenCalled()
    }
  )

  it.each(['eligibility', 'hosted-review'] as const)(
    '%s evidence fills a cached branch miss and renders the review without a click',
    async (source) => {
      const found: PRInfo = {
        number: 12,
        title: 'Recovered PR',
        state: 'open',
        url: 'https://github.com/acme/widgets/pull/12',
        checksStatus: 'success',
        updatedAt: '2026-10-30T00:00:00Z',
        mergeable: 'MERGEABLE',
        headSha: 'head-a'
      }
      const refreshPRNow = vi.fn(async () => ({ kind: 'found', pr: found, fetchedAt: Date.now() }))
      vi.stubGlobal('api', { gh: { refreshPRNow } })
      const key = getGitHubPRCacheKey(repo.path, repo.id, 'main')
      useAppStore.setState({
        repos: [repo],
        prCache: { [key]: { data: null, fetchedAt: Date.now() } },
        hostedReviewCache: {},
        prRefreshStates: {}
      })
      const input = makeInput(githubReview)
      input.prCacheKey = key
      input.hostedReview = null
      input.fetchPRForBranch = useAppStore.getState().fetchPRForBranch
      const { result, rerender } = renderHook(
        ({ evidence, loading }) => {
          const pr = useAppStore((s) => s.prCache[key]?.data ?? null)
          const model: HydrationInput = {
            ...input,
            isPanelVisible: true,
            pr,
            prRefreshState: loading
              ? { status: 'in-flight', reason: 'active', updatedAt: Date.now() }
              : undefined,
            hostedReview: evidence && source === 'hosted-review' ? githubReview : null,
            hostedReviewCreation:
              evidence && source === 'eligibility'
                ? {
                    provider: 'github',
                    review: { number: found.number, url: found.url },
                    canCreate: false,
                    blockedReason: 'existing_review',
                    nextAction: 'open_existing_review',
                    reviewLookupOutcome: 'found'
                  }
                : null
          }
          useChecksPanelGitHubReviewHydration(model)
          return selectChecksPanelReview({
            ...model,
            suppressedGitHubPR: null
          })
        },
        { initialProps: { evidence: false, loading: true } }
      )
      expect(result.current).toBeNull()
      await act(async () => rerender({ evidence: true, loading: true }))
      expect(result.current).toBeNull()
      expect(refreshPRNow).not.toHaveBeenCalled()
      await act(async () => rerender({ evidence: true, loading: false }))
      expect(result.current).toMatchObject({ number: 12, title: 'Recovered PR', status: 'success' })
      expect(useAppStore.getState().prCache[key]?.data).toEqual(found)
      expect(refreshPRNow).toHaveBeenCalledTimes(1)
      expect(refreshPRNow).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ fallbackPRNumber: 12 }),
          reason: 'active'
        })
      )
    }
  )

  it('attempts hydration only once while details stay missing', async () => {
    const input = makeInput(githubReview)
    input.isPanelVisible = true
    input.fetchPRForBranch = vi.fn(async () => null)
    const { rerender } = renderHook(() => useChecksPanelGitHubReviewHydration(input))
    await act(async () => {})
    rerender()
    expect(input.fetchPRForBranch).toHaveBeenCalledTimes(1)
  })

  it.each(['in-flight', 'queued', 'paused', 'error'] as const)(
    'does not start another lookup during %s',
    (status) => {
      const input = makeInput(githubReview)
      input.isPanelVisible = true
      input.prRefreshState = { status, reason: 'active', updatedAt: Date.now() }
      renderHook(() => useChecksPanelGitHubReviewHydration(input))
      expect(input.fetchPRForBranch).not.toHaveBeenCalled()
    }
  )

  it('does not bypass a skipped rate-limit cooldown', () => {
    const input = makeInput(githubReview)
    input.isPanelVisible = true
    input.prRefreshState = {
      status: 'skipped',
      skippedReason: 'rate-limit',
      reason: 'active',
      updatedAt: Date.now(),
      retryDisabledUntil: Date.now() + 60_000
    }
    renderHook(() => useChecksPanelGitHubReviewHydration(input))
    expect(input.fetchPRForBranch).not.toHaveBeenCalled()
  })
})
