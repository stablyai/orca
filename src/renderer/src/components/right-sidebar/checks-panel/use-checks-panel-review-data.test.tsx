// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createModel } from './checks-panel-polling-test-model'
import { useChecksPanelReviewData } from './use-checks-panel-review-data'

afterEach(cleanup)

it('does not send a GitLab pipeline without a job id to the GitHub details loader', async () => {
  const fetchPRCheckDetails = vi.fn(async () => null)
  const model = {
    ...createModel({
      isPanelVisible: false,
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        title: 'Invalid pipeline',
        state: 'open',
        url: 'https://gitlab.com/g/p/-/merge_requests/17',
        status: 'failure',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    }),
    fetchPRCheckDetails,
    fetchPRComments: vi.fn(async () => []),
    gitLabProjectRefRef: { current: { host: 'gitlab.com', path: 'g/p' } }
  }
  const { result, rerender } = renderHook(({ input }) => useChecksPanelReviewData(input), {
    initialProps: { input: model }
  })

  await expect(
    result.current.handleLoadCheckDetails({
      name: 'Pipeline #99',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://gitlab.com/g/p/-/pipelines/99'
    })
  ).resolves.toBeNull()
  expect(fetchPRCheckDetails).not.toHaveBeenCalled()
  rerender({ input: { ...model, activeGitLabReview: null } })
  expect(result.current.getGitLabProjectRef()).toBeNull()
})
