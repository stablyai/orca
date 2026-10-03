// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'

const gitlabJobTrace = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('@/runtime/gitlab-job-trace-client', () => ({
  loadGitLabJobLogDetails: gitlabJobTrace.load
}))

import { useChecksPanelReviewData } from './use-checks-panel-review-data'

type ReviewDataInput = Parameters<typeof useChecksPanelReviewData>[0]
type ReviewDataModel = ReviewDataInput & { settings: ReviewDataInput['ownerSettings'] }

function createModel(): ReviewDataModel {
  const focusedSettings = {
    activeRuntimeEnvironmentId: 'focused-runtime'
  } as ReviewDataInput['ownerSettings']
  const ownerSettings = {
    activeRuntimeEnvironmentId: 'owner-runtime'
  } as ReviewDataInput['ownerSettings']

  return {
    activeGitLabReview: {
      provider: 'gitlab',
      number: 17,
      headSha: 'gitlab-head'
    } as NonNullable<ReviewDataInput['activeGitLabReview']>,
    branch: 'feature/mr',
    fetchPRCheckDetails: vi.fn(),
    fetchPRComments: vi.fn(),
    gitLabProjectRefRef: { current: null },
    isCurrentAsyncResult: vi.fn(() => true),
    isPanelVisible: true,
    ownerSettings,
    pr: null,
    prCacheKey: 'pr-cache',
    prNumber: 17,
    repo: {
      id: 'repo-1',
      path: '/workspace/repo'
    } as NonNullable<ReviewDataInput['repo']>,
    settings: focusedSettings,
    setComments: vi.fn(),
    setCommentsLoading: vi.fn()
  }
}

beforeEach(() => {
  gitlabJobTrace.load.mockReset().mockResolvedValue(null)
})

afterEach(cleanup)

describe('useChecksPanelReviewData', () => {
  it('loads GitLab job logs through the worktree owner runtime', async () => {
    const model = createModel()
    const check: PRCheckDetail = {
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      url: null,
      gitlabJobId: 123
    }
    const { result } = renderHook(() => useChecksPanelReviewData(model))

    await act(async () => result.current.handleLoadCheckDetails(check))

    expect(gitlabJobTrace.load).toHaveBeenCalledWith({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      settings: model.ownerSettings,
      check,
      projectRef: null
    })
    expect(gitlabJobTrace.load).not.toHaveBeenCalledWith(
      expect.objectContaining({ settings: model.settings })
    )
  })
})
