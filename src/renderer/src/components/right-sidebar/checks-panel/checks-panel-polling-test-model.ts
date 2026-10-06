import { vi } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { useChecksPanelPolling } from './use-checks-panel-polling'

type PollingInput = Parameters<typeof useChecksPanelPolling>[0]

export function createModel(overrides: Partial<PollingInput> = {}): PollingInput {
  const fetchPRChecks = vi.fn<() => Promise<PRCheckDetail[]>>().mockResolvedValue([])
  return {
    activeGitLabReview: null,
    activeWorktree: null,
    asyncResultKeyRef: { current: 'cache::main::42' },
    branch: 'main',
    fetchPRChecks,
    hostedReviewCacheKey: 'hosted-review',
    isCurrentAsyncResult: () => true,
    isPanelVisible: true,
    pollIntervalRef: { current: 30_000 },
    pr: {
      number: 42,
      headSha: 'head-1',
      prRepo: { owner: 'orca', repo: 'app', host: 'github.com' },
      title: 'Review',
      state: 'open',
      url: '',
      checksStatus: 'pending',
      updatedAt: '',
      mergeable: 'UNKNOWN'
    },
    prCacheKey: 'cache',
    prNumber: 42,
    prevChecksRef: { current: '' },
    repo: {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'Repo',
      badgeColor: '',
      addedAt: 1
    },
    settings: null,
    setChecks: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsLoading: vi.fn(),
    gitLabProjectRefRef: { current: null },
    ...overrides
  }
}
