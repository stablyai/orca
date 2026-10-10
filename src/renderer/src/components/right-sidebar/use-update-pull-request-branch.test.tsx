// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { useUpdatePullRequestBranch } from './use-update-pull-request-branch'

const { update, success } = vi.hoisted(() => ({ update: vi.fn(), success: vi.fn() }))
vi.mock('./hosted-review-github-actions', () => ({ updateGitHubHostedReviewBranch: update }))
vi.mock('sonner', () => ({ toast: { success } }))

const repo: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const pr: PRInfo = {
  number: 42,
  title: 'Feature',
  state: 'open',
  url: 'https://github.com/upstream/project/pull/42',
  checksStatus: 'pending',
  updatedAt: '',
  mergeable: 'MERGEABLE',
  headSha: 'a'.repeat(40),
  prRepo: { owner: 'upstream', repo: 'project' }
}
const refresh = vi.fn()
const setError = vi.fn()

function setup(githubPR: PRInfo | null = pr) {
  return renderHook(() =>
    useUpdatePullRequestBranch({
      repo,
      prNumber: 42,
      githubPR,
      onRefreshReview: refresh,
      setActionError: setError
    })
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  update.mockResolvedValue({ ok: true })
})
afterEach(cleanup)

describe('useUpdatePullRequestBranch', () => {
  it('uses the displayed PR head and refreshes after GitHub accepts the update', async () => {
    const { result } = setup()
    await act(() => result.current.handleUpdateBranch())
    expect(update).toHaveBeenCalledWith({
      repo,
      prNumber: 42,
      prRepo: pr.prRepo,
      expectedHeadSha: pr.headSha
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(success).toHaveBeenCalledWith('Branch update requested')
    expect(result.current.updatingBranch).toBe(false)
  })

  it('prevents double submission while the request is pending', async () => {
    let complete: (value: { ok: true }) => void = () => {}
    update.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        complete = resolve
      })
    )
    const { result } = setup()
    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.handleUpdateBranch()
      void result.current.handleUpdateBranch()
    })
    expect(result.current.updatingBranch).toBe(true)
    expect(update).toHaveBeenCalledOnce()
    await act(async () => {
      complete({ ok: true })
      await pending
    })
    expect(result.current.updatingBranch).toBe(false)
  })

  it('keeps a GitHub rejection visible and allows retry', async () => {
    update.mockResolvedValue({ ok: false, error: 'Branch has merge conflicts' })
    const { result } = setup()
    await act(() => result.current.handleUpdateBranch())
    expect(setError).toHaveBeenLastCalledWith('Branch has merge conflicts')
    expect(refresh).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
    expect(result.current.updatingBranch).toBe(false)
  })

  it('handles transport failures', async () => {
    update.mockRejectedValue(new Error('Connection lost'))
    const { result } = setup()
    await act(() => result.current.handleUpdateBranch())
    expect(setError).toHaveBeenLastCalledWith('Connection lost')
    expect(result.current.updatingBranch).toBe(false)
  })

  it('does not submit without the displayed head SHA', async () => {
    const { result } = setup({ ...pr, headSha: undefined })
    await act(() => result.current.handleUpdateBranch())
    expect(update).not.toHaveBeenCalled()
  })
})
