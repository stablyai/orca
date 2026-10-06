// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { getDefaultSettings } from '../../../../../shared/constants'
import type * as GitLabReviewClient from './gitlab-review-client'

const poller = vi.hoisted<{
  install: Mock<() => void>
  run: null | (() => Promise<void> | void)
  getDelayMs: null | (() => number | null)
  cleanup: Mock<() => void>
}>(() => ({
  install: vi.fn(),
  run: null,
  getDelayMs: null,
  cleanup: vi.fn()
}))
const gitlab = vi.hoisted(() => ({ fetchDetails: vi.fn() }))

vi.mock('@/lib/window-visibility-timeout-poller', () => ({
  installWindowVisibilityTimeoutPoller: vi.fn(
    (config: { run: () => Promise<void> | void; getDelayMs: () => number | null }) => {
      poller.run = config.run
      poller.getDelayMs = config.getDelayMs
      poller.install()
      return Object.assign(poller.cleanup, { refresh: vi.fn() })
    }
  )
}))
vi.mock('./gitlab-review-client', async (importOriginal) => {
  const original = await importOriginal<typeof GitLabReviewClient>()
  return { ...original, fetchGitLabMRDetailsForChecks: gitlab.fetchDetails }
})

import { useChecksPanelPolling } from './use-checks-panel-polling'

import { createModel } from './checks-panel-polling-test-model'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
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
  vi.useRealTimers()
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
    expect(poller.getDelayMs?.()).toBe(60_000)

    hook.rerender({ input: { ...model, isPanelVisible: false } })
    expect(poller.cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    ['merged', 'success', null],
    ['merged', 'pending', 60_000],
    ['closed', 'success', 15 * 60_000]
  ] as const)('paces %s checks with %s status', (state, checksStatus, interval) => {
    const model = createModel()
    renderHook(() =>
      useChecksPanelPolling({
        ...model,
        pr: model.pr ? { ...model.pr, state, checksStatus } : null
      })
    )
    expect(poller.getDelayMs?.()).toBe(interval)
  })

  it('preserves live repeated-empty backoff at 60, then 120 seconds', async () => {
    const model = createModel()
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(60_000)
    expect(poller.getDelayMs?.()).toBe(60_000)
    vi.setSystemTime(Date.now() + 60_000)
    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(120_000)
    expect(poller.getDelayMs?.()).toBe(120_000)
    vi.setSystemTime(Date.now() + 120_000)
    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(120_000)
    expect(poller.getDelayMs?.()).toBe(120_000)
  })

  it('selects the GitLab adapter without calling the GitHub checks provider', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'gitlab-head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())

    expect(gitlab.fetchDetails).toHaveBeenCalledOnce()
    expect(model.fetchPRChecks).not.toHaveBeenCalled()
  })

  it('uses an explicit owner and missing head override for a replacement MR', async () => {
    const ownerSettings = {
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: 'owner-runtime'
    }
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'old-head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      },
      activeWorktree: makeWorktree({
        id: 'worktree-1',
        repoId: 'repo-1',
        hostId: 'runtime:owner-runtime'
      }),
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'focused-runtime' }
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

    expect(model.setChecks).toHaveBeenCalledExactlyOnceWith([])
    expect(model.setComments).toHaveBeenCalledExactlyOnceWith([])
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
