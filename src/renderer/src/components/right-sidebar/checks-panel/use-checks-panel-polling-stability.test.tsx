// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { createModel } from './checks-panel-polling-test-model'
import { useChecksPanelPolling } from './use-checks-panel-polling'

const gitlab = vi.hoisted(() => ({ fetchDetails: vi.fn() }))
vi.mock('./gitlab-review-client', () => ({
  fetchGitLabMRDetailsForChecks: gitlab.fetchDetails,
  gitLabMRCommentsToPRComments: () => []
}))

const pending: PRCheckDetail[] = [{ name: 'Build', status: 'queued', conclusion: null, url: null }]
const settled: PRCheckDetail[] = [
  { name: 'Build', status: 'completed', conclusion: 'success', url: null }
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  gitlab.fetchDetails.mockReset().mockResolvedValue({ item: {}, pipelineJobs: [], comments: [] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('checks detail polling ownership', () => {
  it('keeps pending details polling despite a settled aggregate and stops on settled details', async () => {
    const model = createModel()
    if (model.pr) {
      model.pr = { ...model.pr, state: 'merged', checksStatus: 'success' }
    }
    const fetch = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(settled)
    model.fetchPRChecks = fetch
    renderHook(() => useChecksPanelPolling(model))
    await advance(0)
    expect(fetch).toHaveBeenCalledOnce()
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await advance(900_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rechecks a settled review when pending returns, with the resume cooldown', async () => {
    const model = createModel()
    if (model.pr) {
      model.pr = { ...model.pr, state: 'merged', checksStatus: 'success' }
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(settled)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(settled)
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(2000)
    hook.rerender({
      input: { ...model, pr: model.pr ? { ...model.pr, checksStatus: 'pending' } : null }
    })
    await advance(7999)
    expect(fetch).toHaveBeenCalledOnce()
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith(
      '/workspace/repo',
      42,
      'main',
      'head-1',
      model.pr?.prRepo,
      expect.objectContaining({ force: true, throwOnError: true })
    )
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    await advance(900_000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('preserves the timer and backoff when repository cache objects are replaced', async () => {
    const model = createModel()
    const fetch = vi.fn().mockResolvedValue(pending)
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await advance(30_000)
    hook.rerender({
      input: {
        ...model,
        repo: model.repo ? { ...model.repo } : null,
        pr: model.pr
          ? { ...model.pr, prRepo: model.pr.prRepo ? { ...model.pr.prRepo } : undefined }
          : null
      }
    })
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await advance(30_000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('preserves a GitLab details timer when its cache object is replaced', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(0)
    hook.rerender({
      input: {
        ...model,
        activeGitLabReview: model.activeGitLabReview ? { ...model.activeGitLabReview } : null
      }
    })
    await advance(59_999)
    expect(gitlab.fetchDetails).toHaveBeenCalledOnce()
    await advance(1)
    expect(gitlab.fetchDetails).toHaveBeenCalledTimes(2)
  })

  it('keeps good checks on errors and retries merged unknown details with backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const model = createModel()
    if (model.pr) {
      model.pr = { ...model.pr, state: 'merged', checksStatus: 'success' }
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(settled)
    model.fetchPRChecks = fetch
    renderHook(() => useChecksPanelPolling(model))
    await advance(60_000)
    expect(model.setChecks).toHaveBeenCalledTimes(2)
    expect(model.setChecks).toHaveBeenLastCalledWith(pending)
    await advance(119_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    await advance(900_000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does no hidden work and coalesces visibility and focus return bursts', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const model = createModel()
    const fetch = vi.fn().mockResolvedValue(pending)
    model.fetchPRChecks = fetch
    renderHook(() => useChecksPanelPolling(model))
    await advance(900_000)
    expect(fetch).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await advance(0)
    act(() => window.dispatchEvent(new Event('focus')))
    await advance(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retains failed detail backoff and good rows across panel hiding and reopening', async () => {
    const model = createModel()
    const fetch = vi.fn().mockResolvedValueOnce(pending).mockRejectedValue(new Error('offline'))
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    const writes = vi.mocked(model.setChecks).mock.calls.length
    await advance(1_000)
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await advance(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(model.setChecks).toHaveBeenCalledTimes(writes)
    await advance(118_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await advance(239_999)
    expect(fetch).toHaveBeenCalledTimes(3)
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('does not start a second detail request on reopening while the first is pending', async () => {
    const model = createModel()
    let finish: (checks: PRCheckDetail[]) => void = () => {}
    const fetch = vi.fn(() => new Promise<PRCheckDetail[]>((resolve) => (finish = resolve)))
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(1_000)
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await advance(0)
    expect(fetch).toHaveBeenCalledOnce()
    await act(async () => finish(pending))
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps settled details stopped across a quick reopening and discovers stale exposure once', async () => {
    const model = createModel()
    if (model.pr) {
      model.pr = { ...model.pr, state: 'merged', checksStatus: 'success' }
    }
    const fetch = vi.fn().mockResolvedValue(settled)
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(1_000)
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await advance(0)
    expect(fetch).toHaveBeenCalledOnce()
    await advance(59_000)
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await advance(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    await advance(900_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('clears details and starts discovery when the review identity changes after failure', async () => {
    const model = createModel()
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(settled)
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(1_000)
    hook.rerender({
      input: { ...model, pr: model.pr ? { ...model.pr, headSha: 'new-head' } : null }
    })
    await advance(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[3]).toBe('new-head')
    expect(model.setChecks).toHaveBeenLastCalledWith(settled)
  })

  it('retains GitLab failure backoff when the same panel is reopened', async () => {
    gitlab.fetchDetails.mockRejectedValue(new Error('offline'))
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'head',
        title: 'MR',
        state: 'merged',
        url: '',
        status: 'success',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(1_000)
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await advance(0)
    expect(gitlab.fetchDetails).toHaveBeenCalledOnce()
    await advance(118_999)
    expect(gitlab.fetchDetails).toHaveBeenCalledOnce()
    await advance(1)
    expect(gitlab.fetchDetails).toHaveBeenCalledTimes(2)
  })

  it('retains a pending transition that arrives during a settled detail request', async () => {
    const model = createModel()
    if (model.pr) {
      model.pr = { ...model.pr, state: 'merged', checksStatus: 'success' }
    }
    let finish: (checks: PRCheckDetail[]) => void = () => {}
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<PRCheckDetail[]>((resolve) => (finish = resolve)))
      .mockResolvedValue(settled)
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await advance(1_000)
    hook.rerender({
      input: { ...model, pr: model.pr ? { ...model.pr, checksStatus: 'pending' } : null }
    })
    await act(async () => finish(settled))
    await advance(8_999)
    expect(fetch).toHaveBeenCalledOnce()
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith(
      '/workspace/repo',
      42,
      'main',
      'head-1',
      model.pr?.prRepo,
      expect.objectContaining({ force: true })
    )
  })
})
