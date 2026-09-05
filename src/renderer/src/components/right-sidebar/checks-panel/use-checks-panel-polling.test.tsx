// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type * as GitLabReviewClient from './gitlab-review-client'

const poller = vi.hoisted(() => ({
  install: vi.fn(),
  run: null as null | (() => Promise<void> | void),
  getDelayMs: null as null | (() => number),
  cleanup: vi.fn()
}))
const gitlab = vi.hoisted(() => ({ fetchDetails: vi.fn() }))

vi.mock('@/lib/window-visibility-timeout-poller', () => ({
  installWindowVisibilityTimeoutPoller: vi.fn(
    (config: { run: () => Promise<void> | void; getDelayMs: () => number }) => {
      poller.run = config.run
      poller.getDelayMs = config.getDelayMs
      poller.install()
      return poller.cleanup
    }
  )
}))
vi.mock('./gitlab-review-client', async (importOriginal) => {
  const original = await importOriginal<typeof GitLabReviewClient>()
  return { ...original, fetchGitLabMRDetailsForChecks: gitlab.fetchDetails }
})

import { useChecksPanelPolling } from './use-checks-panel-polling'

type PollingInput = Parameters<typeof useChecksPanelPolling>[0]

function createModel(overrides: Partial<PollingInput> = {}): PollingInput {
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
      prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
    } as NonNullable<PollingInput['pr']>,
    prCacheKey: 'cache',
    prNumber: 42,
    prevChecksRef: { current: '' },
    repo: { id: 'repo-1', path: '/workspace/repo' } as NonNullable<PollingInput['repo']>,
    settings: null,
    setChecks: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsLoading: vi.fn(),
    gitLabProjectRefRef: { current: null },
    ...overrides
  }
}

beforeEach(() => {
  poller.install.mockReset()
  poller.cleanup.mockReset()
  poller.run = null
  poller.getDelayMs = null
  gitlab.fetchDetails.mockReset().mockResolvedValue({
    item: { projectRef: null },
    pipelineJobs: [],
    comments: []
  })
})

afterEach(() => {
  cleanup()
})

describe('useChecksPanelPolling live behavior', () => {
  it('gates installation by panel visibility and cleans the active poller', () => {
    const model = createModel({ isPanelVisible: false })
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })

    expect(poller.install).not.toHaveBeenCalled()

    hook.rerender({ input: { ...model, isPanelVisible: true } })
    expect(poller.install).toHaveBeenCalledOnce()
    expect(poller.getDelayMs?.()).toBe(30_000)

    hook.rerender({ input: { ...model, isPanelVisible: false } })
    expect(poller.cleanup).toHaveBeenCalledOnce()
  })

  it('preserves live repeated-empty backoff at 30, 60, then 120 seconds', async () => {
    const model = createModel()
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(30_000)
    expect(poller.getDelayMs?.()).toBe(30_000)
    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(60_000)
    expect(poller.getDelayMs?.()).toBe(60_000)
    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(120_000)
    expect(poller.getDelayMs?.()).toBe(120_000)
  })

  it('selects the GitLab adapter without calling the GitHub checks provider', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'gitlab-head'
      } as NonNullable<PollingInput['activeGitLabReview']>
    })
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())

    expect(gitlab.fetchDetails).toHaveBeenCalledOnce()
    expect(model.fetchPRChecks).not.toHaveBeenCalled()
  })

  it('uses an explicit owner and missing head override for a replacement MR', async () => {
    const ownerSettings = {
      activeRuntimeEnvironmentId: 'owner-runtime'
    } as PollingInput['settings']
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'old-head'
      } as NonNullable<PollingInput['activeGitLabReview']>,
      activeWorktree: makeWorktree({
        id: 'worktree-1',
        repoId: 'repo-1',
        hostId: 'runtime:owner-runtime'
      }),
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as PollingInput['settings']
    })
    const { result } = renderHook(() => useChecksPanelPolling(model))

    await act(async () =>
      result.current.fetchGitLabDetails({
        mrNumberOverride: 18,
        headShaOverride: null,
        commitAsCurrent: true,
        settingsOverride: ownerSettings
      })
    )

    expect(gitlab.fetchDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        iid: 18,
        settings: ownerSettings,
        repoOwnerExecutionHostId: 'runtime:owner-runtime'
      })
    )
    expect(model.asyncResultKeyRef.current).toContain('::18::none')
    expect(model.asyncResultKeyRef.current).not.toContain('old-head')
  })

  it('drops replacement MR details when the relink scope changes in flight', async () => {
    let resolveDetails!: (value: {
      item: { projectRef: null }
      pipelineJobs: PRCheckDetail[]
      comments: []
    }) => void
    gitlab.fetchDetails.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDetails = resolve
      })
    )
    let requestCurrent = true
    const model = createModel()
    const { result } = renderHook(() => useChecksPanelPolling(model))

    const request = result.current.fetchGitLabDetails({
      mrNumberOverride: 18,
      commitAsCurrent: true,
      isRequestCurrent: () => requestCurrent
    })
    await act(() => Promise.resolve())
    requestCurrent = false
    resolveDetails({
      item: { projectRef: null },
      pipelineJobs: [],
      comments: []
    })
    await act(async () => request)

    expect(model.setChecks).not.toHaveBeenCalled()
    expect(model.setComments).not.toHaveBeenCalled()
    expect(model.setChecksLoading).toHaveBeenLastCalledWith(false)
    expect(model.setCommentsLoading).toHaveBeenLastCalledWith(false)
  })

  it('keeps loading owned by the newest replacement MR details request', async () => {
    const detailsResolvers: ((value: {
      item: { projectRef: null }
      pipelineJobs: []
      comments: []
    }) => void)[] = []
    gitlab.fetchDetails.mockImplementation(
      () =>
        new Promise((resolve) => {
          detailsResolvers.push(resolve)
        })
    )
    let firstRequestCurrent = true
    const model = createModel()
    const { result } = renderHook(() => useChecksPanelPolling(model))

    const firstRequest = result.current.fetchGitLabDetails({
      mrNumberOverride: 18,
      commitAsCurrent: true,
      isRequestCurrent: () => firstRequestCurrent
    })
    await act(() => Promise.resolve())
    firstRequestCurrent = false
    const secondRequest = result.current.fetchGitLabDetails({
      mrNumberOverride: 18,
      commitAsCurrent: true
    })
    await act(() => Promise.resolve())

    detailsResolvers[0]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    await act(async () => firstRequest)
    expect(model.setChecksLoading).not.toHaveBeenCalledWith(false)
    expect(model.setCommentsLoading).not.toHaveBeenCalledWith(false)

    detailsResolvers[1]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    await act(async () => secondRequest)
    expect(model.setChecksLoading).toHaveBeenLastCalledWith(false)
    expect(model.setCommentsLoading).toHaveBeenLastCalledWith(false)
  })
})
