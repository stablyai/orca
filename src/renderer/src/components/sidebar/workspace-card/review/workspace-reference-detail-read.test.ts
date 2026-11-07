// @vitest-environment happy-dom
import { linearIssueReadFixture } from '@/store/slices/linear/linear-slice-test-harness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'

import { readWorkspaceReferenceDetails } from './workspace-reference-detail-read'
import { getWorkspaceReferenceRequest } from './workspace-reference-details'
import {
  referenceAttachment,
  referenceRepo,
  referenceWorkspace,
  referenceReview
} from './workspace-reference-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  review: vi.fn<(...args: unknown[]) => Promise<HostedReviewInfo | null>>(),
  linear: vi.fn<(...args: unknown[]) => Promise<LinearIssue | null>>(),
  jira: vi.fn(),
  issue: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      hostedReviewCache: {},
      linearIssueCache: {},
      jiraIssueSummaryCache: {},
      issueCache: {},
      fetchHostedReviewForBranch: mocks.review,
      settings: { activeRuntimeEnvironmentId: 'focused-elsewhere' },
      fetchLinearIssue: (...args: unknown[]) => linearIssueReadFixture(() => mocks.linear(...args)),
      lookupJiraIssueSummary: mocks.jira,
      fetchIssue: mocks.issue
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { hostedReview: { forBranch: mocks.review } }
  })
})
describe('source-scoped workspace reference status reads', () => {
  it('retains native admission after hover cancellation until the timed-out read settles', async () => {
    const rejecters: ((error: Error) => void)[] = []
    mocks.linear.mockImplementation(() => new Promise((_resolve, reject) => rejecters.push(reject)))
    mocks.review.mockResolvedValue(referenceReview(99))
    const controller = new AbortController()
    const tasks = Array.from({ length: 3 }, (_, index) =>
      readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(
          { provider: 'linear', type: 'issue', number: 0, identifier: `ENG-${index + 1}` },
          referenceWorkspace,
          referenceRepo
        ),
        controller.signal
      ).catch(() => null)
    )
    try {
      await vi.waitFor(() => expect(mocks.linear).toHaveBeenCalledTimes(3))
      controller.abort()
      const review = readWorkspaceReferenceDetails(
        getWorkspaceReferenceRequest(referenceAttachment(99), referenceWorkspace, referenceRepo)
      )
      await Promise.resolve()
      expect(mocks.review).not.toHaveBeenCalled()
      rejecters[0](new Error('Linear issue detail lookup timed out'))
      await expect(review).resolves.toMatchObject({ title: 'Review 99' })
    } finally {
      for (const reject of rejecters) {
        reject(new Error('Read settled'))
      }
      await Promise.all(tasks)
    }
  })
})
