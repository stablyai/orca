import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PRCheckDetail,
  PRCheckRunDetails,
  PRInfo,
  Repo,
  Worktree
} from '../../../../shared/types'
import {
  getCheckRunDetailsFixDisabledReason,
  isCheckRunDetailsFixCandidate,
  resolveCheckRunDetailsFixCheck,
  resolveHostedReviewForCheckRunDetailsFix,
  startCheckRunDetailsFixWithAI
} from './check-run-details-fix-with-ai'

const startFixChecksAgent = vi.fn()

const fixtures = vi.hoisted(() => {
  const repo: Repo = {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: '#2563eb',
    addedAt: 1,
    connectionId: null,
    executionHostId: null
  }
  const worktree: Worktree = {
    id: 'repo-1::/tmp/repo/feature',
    repoId: 'repo-1',
    path: '/tmp/repo/feature',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: 42,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  const pr: PRInfo = {
    number: 42,
    title: 'Fix CI',
    state: 'open',
    url: 'https://github.com/acme/widgets/pull/42',
    checksStatus: 'failure',
    updatedAt: '2026-06-16T00:00:00Z',
    mergeable: 'MERGEABLE'
  }
  const failingCheck: PRCheckDetail = {
    name: 'verify',
    status: 'completed',
    conclusion: 'failure',
    url: null,
    checkRunId: 42
  }
  const checkDetails: PRCheckRunDetails = {
    name: 'verify',
    status: 'completed',
    conclusion: 'failure',
    url: null,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    title: null,
    summary: null,
    text: null,
    annotations: [],
    jobs: [
      {
        id: 1,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null,
        url: null,
        steps: [],
        logTail: 'assertion failed'
      }
    ]
  }
  const prCacheKey = 'repo-1::feature'
  return { repo, worktree, pr, failingCheck, checkDetails, prCacheKey }
})

const storeState = vi.hoisted(() => ({
  worktreesByRepo: { 'repo-1': [fixtures.worktree] } as Record<string, Worktree[]>,
  repos: [fixtures.repo] as Repo[],
  settings: {},
  prCache: {
    [fixtures.prCacheKey]: { data: fixtures.pr, fetchedAt: 1 }
  } as Record<string, { data: PRInfo; fetchedAt: number }>,
  hostedReviewCache: {} as Record<string, { data: unknown }>
}))

vi.mock('@/lib/worktree-git-identity-display', () => ({
  getWorktreeGitIdentityDisplay: () => ({ kind: 'branch', branchName: 'feature' })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState
    }
  )
}))

vi.mock('@/lib/fix-checks-agent-launch', () => ({
  startFixChecksAgent: (...args: unknown[]) => startFixChecksAgent(...args)
}))

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn()
  }
}))

beforeEach(() => {
  startFixChecksAgent.mockReset()
  startFixChecksAgent.mockResolvedValue(true)
  storeState.worktreesByRepo = { 'repo-1': [fixtures.worktree] }
  storeState.repos = [fixtures.repo]
  storeState.prCache = {
    [fixtures.prCacheKey]: { data: fixtures.pr, fetchedAt: 1 }
  }
  storeState.hostedReviewCache = {}
})

describe('check-run-details-fix-with-ai', () => {
  it('detects failing checks as fix candidates', () => {
    expect(isCheckRunDetailsFixCandidate(fixtures.failingCheck)).toBe(true)
    expect(
      isCheckRunDetailsFixCandidate({
        ...fixtures.failingCheck,
        conclusion: 'success'
      })
    ).toBe(false)
  })

  it('prefers loaded details conclusion over the list-level check', () => {
    const listFailure = fixtures.failingCheck
    const passingDetails: PRCheckRunDetails = {
      ...fixtures.checkDetails,
      conclusion: 'success',
      status: 'completed'
    }
    expect(isCheckRunDetailsFixCandidate(listFailure, passingDetails)).toBe(false)
    expect(
      resolveCheckRunDetailsFixCheck(
        { ...fixtures.failingCheck, conclusion: 'success' },
        fixtures.checkDetails
      ).conclusion
    ).toBe('failure')
    expect(
      isCheckRunDetailsFixCandidate(
        { ...fixtures.failingCheck, conclusion: 'success' },
        fixtures.checkDetails
      )
    ).toBe(true)
  })

  it('resolves hosted review metadata from the worktree PR cache', () => {
    expect(resolveHostedReviewForCheckRunDetailsFix(fixtures.worktree.id)).toMatchObject({
      number: 42,
      title: 'Fix CI',
      url: 'https://github.com/acme/widgets/pull/42'
    })
  })

  it('requires a hosted review before launching an AI fix', () => {
    storeState.prCache = {}
    expect(getCheckRunDetailsFixDisabledReason(fixtures.worktree.id)).toContain('PR or MR')
  })

  it('starts a single-check AI fix prompt for the owning worktree', async () => {
    await startCheckRunDetailsFixWithAI({
      worktreeId: fixtures.worktree.id,
      check: fixtures.failingCheck,
      details: fixtures.checkDetails
    })

    expect(startFixChecksAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-1',
        worktreeId: fixtures.worktree.id,
        groupId: fixtures.worktree.id,
        launchSource: 'task_page',
        basePrompt: expect.stringContaining('"name": "verify"')
      })
    )
    expect(startFixChecksAgent.mock.calls[0]?.[0]?.basePrompt).toContain('assertion failed')
  })
})
