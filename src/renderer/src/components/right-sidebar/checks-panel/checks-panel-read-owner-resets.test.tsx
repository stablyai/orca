// @vitest-environment happy-dom

import { act, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecksDetailPollingPolicy } from '../../../../../shared/github/checks/checks-detail-polling-policy'
import { useChecksDetailTimer } from './refresh/use-checks-detail-timer'
import type { ChecksPanelPollingInput } from './refresh/use-checks-panel-polling'
import { useChecksPanelReviewData } from './review-data/use-checks-panel-review-data'
import { ChecksList } from './presentation/checks-list'
import { PRCommentsList } from './comments/comments-list'
import { refreshChecksPanelHostedReview } from './refresh/hosted-review-manual-refresh'
import type { ChecksPanelManualRefreshInput } from './refresh/manual-refresh-dependencies'
import { useAppStore } from '@/store/index'

type HostedReviewCacheEntry = ReturnType<typeof useAppStore.getState>['hostedReviewCache'][string]

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type FixtureFields<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [Key in keyof T]?: FixtureFields<T[Key]> }
    : T

function testDouble<T>(value: FixtureFields<T>): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each double supplies every field the hook or helper under test reads; the rest of the panel model is unused here.
  return value as T
}
const isCurrentAsyncResult = (): boolean => true
const fetchPRCheckDetails = vi.fn()
const gitLabProjectRefRef = { current: null }

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('api', {
    ...window.api,
    gh: { ...window.api?.gh, onWorkItemMutated: () => () => {} }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const repo = { id: 'repo-1', path: '/fixture/repo', executionHostId: null, connectionId: null }

function setters() {
  return {
    setChecks: vi.fn(),
    setChecksError: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsError: vi.fn(),
    setCommentsLoading: vi.fn()
  }
}

function TimerHost({
  model,
  requestIdentity,
  fetchChecks
}: {
  model: ChecksPanelPollingInput
  requestIdentity: string
  fetchChecks: () => Promise<void>
}): null {
  const modelRef = useRef(model)
  // Same order as the production polling hook: refresh the ref before the timer effect runs.
  useEffect(() => {
    modelRef.current = model
  })
  const policyRef = useRef(new ChecksDetailPollingPolicy())
  useChecksDetailTimer({
    model,
    modelRef,
    policyRef,
    requestIdentity,
    fetchChecks,
    fetchGitLabDetails: fetchChecks
  })
  return null
}

function timerModel(set: ReturnType<typeof setters>, gitLab: boolean): ChecksPanelPollingInput {
  return testDouble<ChecksPanelPollingInput>({
    ...set,
    activeGitLabReview: gitLab ? { number: 7, state: 'merged', status: 'success' } : null,
    pr: gitLab ? null : { number: 7, state: 'merged', checksStatus: 'success' },
    prNumber: gitLab ? null : 7,
    prCacheKey: 'cache',
    hostedReviewCacheKey: 'cache',
    repo,
    branch: 'feature',
    isPanelVisible: true,
    pollIntervalRef: { current: 60_000 },
    prevChecksRef: { current: '' }
  })
}

describe('checks timer resets', () => {
  it('keeps results and reads nothing more when its read identity is unchanged', async () => {
    const set = setters()
    const fetchChecks = vi.fn(async () => {})
    const model = timerModel(set, false)
    act(() =>
      root.render(<TimerHost model={model} requestIdentity="a" fetchChecks={fetchChecks} />)
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const reads = fetchChecks.mock.calls.length
    // A push-target-only change re-renders the panel without touching the checks read inputs.
    act(() =>
      root.render(<TimerHost model={{ ...model }} requestIdentity="a" fetchChecks={fetchChecks} />)
    )
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(set.setChecks).not.toHaveBeenCalled()
    expect(set.setComments).not.toHaveBeenCalled()
    expect(fetchChecks).toHaveBeenCalledTimes(reads)
  })

  it('resets GitHub checks only, and reads them again, when the identity changes', async () => {
    const set = setters()
    const fetchChecks = vi.fn(async () => {})
    const model = timerModel(set, false)
    act(() =>
      root.render(<TimerHost model={model} requestIdentity="a" fetchChecks={fetchChecks} />)
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const reads = fetchChecks.mock.calls.length
    act(() =>
      root.render(<TimerHost model={model} requestIdentity="b" fetchChecks={fetchChecks} />)
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(set.setChecks).toHaveBeenCalledWith(null)
    // GitHub comments belong to their own read; a checks identity change must not strand them.
    expect(set.setComments).not.toHaveBeenCalled()
    expect(fetchChecks.mock.calls.length).toBeGreaterThan(reads)
  })

  it('resets GitLab comments with checks, since one read settles both', async () => {
    const set = setters()
    const fetchChecks = vi.fn(async () => {})
    const model = timerModel(set, true)
    act(() =>
      root.render(<TimerHost model={model} requestIdentity="a" fetchChecks={fetchChecks} />)
    )
    act(() =>
      root.render(<TimerHost model={model} requestIdentity="b" fetchChecks={fetchChecks} />)
    )
    expect(set.setChecks).toHaveBeenCalledWith(null)
    expect(set.setComments).toHaveBeenCalledWith(undefined)
  })
})

type ReviewDataModel = Parameters<typeof useChecksPanelReviewData>[0]

function ReviewDataHost({ model }: { model: ReviewDataModel }): null {
  useChecksPanelReviewData(model)
  return null
}

function reviewDataModel(
  set: ReturnType<typeof setters>,
  fetchPRComments: ReturnType<typeof vi.fn>,
  overrides: { headSha?: string; hostId?: string } = {}
): ReviewDataModel {
  return testDouble<ReviewDataModel>({
    ...set,
    activeGitLabReview: null,
    branch: 'feature',
    fetchPRCheckDetails,
    fetchPRComments,
    gitLabProjectRefRef,
    isCurrentAsyncResult,
    isPanelVisible: true,
    pr: { number: 7, headSha: overrides.headSha ?? 'sha-1', prRepo: null },
    prCacheKey: 'cache',
    prNumber: 7,
    repo,
    activeWorktree: { id: 'wt', hostId: overrides.hostId ?? 'local' }
  })
}

describe('GitHub comments resets', () => {
  it('keeps comments, with no extra read, when only the worktree host representation changes', async () => {
    const set = setters()
    const fetchPRComments = vi.fn(async () => [])
    act(() => root.render(<ReviewDataHost model={reviewDataModel(set, fetchPRComments)} />))
    await act(async () => {})
    const reads = fetchPRComments.mock.calls.length
    set.setComments.mockClear()
    act(() =>
      root.render(
        <ReviewDataHost model={reviewDataModel(set, fetchPRComments, { hostId: 'local:alias' })} />
      )
    )
    await act(async () => {})
    expect(set.setComments).not.toHaveBeenCalledWith(undefined)
    expect(fetchPRComments).toHaveBeenCalledTimes(reads)
  })

  it('resets and reads again when the comments read inputs change', async () => {
    const set = setters()
    const fetchPRComments = vi.fn(async () => [])
    act(() => root.render(<ReviewDataHost model={reviewDataModel(set, fetchPRComments)} />))
    await act(async () => {})
    const reads = fetchPRComments.mock.calls.length
    set.setComments.mockClear()
    act(() =>
      root.render(
        <ReviewDataHost model={reviewDataModel(set, fetchPRComments, { headSha: 'sha-2' })} />
      )
    )
    await act(async () => {})
    expect(set.setComments).toHaveBeenNthCalledWith(1, undefined)
    expect(fetchPRComments).toHaveBeenCalledTimes(reads + 1)
  })
})

describe('empty copy under a refresh banner', () => {
  function renderChecks(checksRead: boolean): void {
    act(() =>
      root.render(
        <ChecksList
          checks={[]}
          checksError={null}
          checksLoading={false}
          loadingSkeleton={false}
          checksRead={checksRead}
          checkDetailsContextKey="fixture"
          worktreeId="fixture-worktree"
        />
      )
    )
  }

  function renderComments(commentsRead: boolean): void {
    act(() =>
      root.render(
        <PRCommentsList
          comments={[]}
          commentsError={null}
          commentsLoading={false}
          loadingSkeleton={false}
          commentsRead={commentsRead}
        />
      )
    )
  }

  it('withholds "No checks configured" until a read confirms it', () => {
    renderChecks(false)
    expect(container.textContent).not.toContain('No checks configured')
    renderChecks(true)
    expect(container.textContent).toContain('No checks configured')
  })

  it('withholds "No comments" until a read confirms it', () => {
    renderComments(false)
    expect(container.textContent).not.toContain('No comments')
    renderComments(true)
    expect(container.textContent).toContain('No comments')
  })
})

describe('manual refresh lookups', () => {
  it('keeps current results when the review lookup finds nothing', async () => {
    const set = setters()
    const fetchGitLabDetails = vi.fn(async () => {})
    const model = testDouble<ChecksPanelManualRefreshInput>({
      ...set,
      repo,
      branch: 'feature',
      activeGitLabReview: null,
      fetchGitLabDetails,
      fetchHostedReviewForBranch: vi.fn(async () => null),
      linkedPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      fallbackGitHubPRNumber: null
    })
    await expect(refreshChecksPanelHostedReview(model, 'gitlab', () => true)).resolves.toBe(
      'no-review'
    )
    // Nothing would re-read a section cleared here while the selected review stays the same.
    expect(set.setChecks).not.toHaveBeenCalled()
    expect(set.setComments).not.toHaveBeenCalled()
    expect(fetchGitLabDetails).not.toHaveBeenCalled()
  })

  function gitLabReview(number: number, headSha: string) {
    return { provider: 'gitlab', number, headSha, state: 'open', title: `MR ${number}` } as const
  }

  function gitLabRefreshModel(
    card: ReturnType<typeof gitLabReview> | null,
    captured: ReturnType<typeof gitLabReview> | null
  ) {
    const fetchGitLabDetails = vi.fn(async () => {})
    const model = testDouble<ChecksPanelManualRefreshInput>({
      ...setters(),
      repo,
      branch: 'feature',
      hostedReviewCacheKey: 'hosted-key',
      activeGitLabReview: captured,
      fetchGitLabDetails,
      fetchHostedReviewForBranch: vi.fn(async () => card),
      linkedPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      fallbackGitHubPRNumber: null
    })
    return { model, fetchGitLabDetails }
  }

  function publish(review: ReturnType<typeof gitLabReview> | null): void {
    useAppStore.setState({
      hostedReviewCache: {
        'hosted-key': testDouble<HostedReviewCacheEntry>({ data: review, fetchedAt: Date.now() })
      }
    })
  }

  afterEach(() => useAppStore.setState({ hostedReviewCache: {} }))

  it('reads the published replacement, not the MR a late click captured', async () => {
    // A title save published MR 18 while this click, begun on MR 17, still waited.
    publish(gitLabReview(18, 'sha-18'))
    const { model, fetchGitLabDetails } = gitLabRefreshModel(
      gitLabReview(17, 'sha-17'),
      gitLabReview(17, 'sha-17')
    )
    await refreshChecksPanelHostedReview(model, 'gitlab', () => true)
    expect(fetchGitLabDetails).toHaveBeenCalledTimes(1)
    expect(fetchGitLabDetails).toHaveBeenCalledWith(
      expect.objectContaining({ mrNumberOverride: 18, headShaOverride: 'sha-18' })
    )
  })

  it('still reads the selected MR when the card lookup comes back empty', async () => {
    publish(gitLabReview(17, 'sha-17'))
    const { model, fetchGitLabDetails } = gitLabRefreshModel(null, gitLabReview(17, 'sha-17'))
    await refreshChecksPanelHostedReview(model, 'gitlab', () => true)
    expect(fetchGitLabDetails).toHaveBeenCalledWith(
      expect.objectContaining({ mrNumberOverride: 17, headShaOverride: 'sha-17' })
    )
  })

  it('reads nothing when the published selection no longer has an MR', async () => {
    publish(null)
    const { model, fetchGitLabDetails } = gitLabRefreshModel(
      gitLabReview(17, 'sha-17'),
      gitLabReview(17, 'sha-17')
    )
    await expect(refreshChecksPanelHostedReview(model, 'gitlab', () => true)).resolves.toBe(
      'no-review'
    )
    expect(fetchGitLabDetails).not.toHaveBeenCalled()
  })
})
