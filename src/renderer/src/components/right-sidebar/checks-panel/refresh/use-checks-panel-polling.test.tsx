// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type * as GitLabReviewClient from '../gitlab-review-client'

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
vi.mock('../gitlab-review-client', async (importOriginal) => {
  const original = await importOriginal<typeof GitLabReviewClient>()
  return { ...original, fetchGitLabMRDetailsForChecks: gitlab.fetchDetails }
})

import { useChecksPanelPolling } from './use-checks-panel-polling'

import { createModel } from './checks-panel-polling-test-model'

const baseRepo = createModel().repo
if (!baseRepo) {
  throw new Error('The polling fixture requires a repository.')
}

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
