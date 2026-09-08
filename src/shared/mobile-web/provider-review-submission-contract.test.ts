import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS } from './provider-review-contract'
import {
  MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_COMMENT_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_TOTAL_MAX_CHARACTERS,
  MobileWebProviderReviewSubmissionPayloadSchema,
  MobileWebProviderReviewSubmissionResultSchema
} from './provider-review-submission-contract'

const repositoryHead = 'a'.repeat(40)
const reviewHead = 'b'.repeat(40)

describe('mobile web provider review submission contract', () => {
  it('retains bounded review identity, verdict, summary, and queued comments', () => {
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.parse({
        workspaceId: 'repo-1::/workspace',
        expectedHead: repositoryHead,
        expectedBranch: 'feature/review',
        provider: 'github',
        reviewNumber: 17,
        expectedReviewHead: reviewHead,
        submissionId: 'submission_1234567890',
        action: 'request-changes',
        summary: '  Please address the queued comments.  ',
        comments: [
          {
            id: 'comment_1234567890',
            path: 'src/review.ts',
            line: 12,
            body: '  Keep this bounded.  '
          }
        ]
      })
    ).toMatchObject({
      summary: 'Please address the queued comments.',
      comments: [{ body: 'Keep this bounded.' }]
    })
  })

  it('rejects traversal, duplicate ids, invalid ranges, and oversized queues', () => {
    const base = {
      workspaceId: 'repo-1::/workspace',
      expectedHead: repositoryHead,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 17,
      expectedReviewHead: reviewHead,
      submissionId: 'submission_1234567890',
      action: 'comment',
      summary: ''
    } as const
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        comments: [
          {
            id: 'comment_1234567890',
            path: '../outside.ts',
            line: 12,
            body: 'No traversal'
          }
        ]
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        comments: [
          { id: 'comment_1234567890', path: 'a.ts', line: 4, body: 'First' },
          { id: 'comment_1234567890', path: 'b.ts', line: 2, body: 'Second' }
        ]
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        comments: [
          {
            id: 'comment_1234567890',
            path: 'a.ts',
            startLine: 5,
            line: 4,
            body: 'Invalid range'
          }
        ]
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        comments: Array.from(
          { length: MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_COMMENT_LIMIT + 1 },
          (_, index) => ({
            id: `comment_${String(index).padStart(16, '0')}`,
            path: 'a.ts',
            line: index + 1,
            body: 'Bounded'
          })
        )
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        comments: [
          {
            id: 'comment_1234567890',
            path: 'a.ts',
            line: 1,
            body: 'x'.repeat(MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS + 1)
          }
        ]
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        summary: 's',
        comments: Array.from({ length: 8 }, (_, index) => ({
          id: `comment_${String(index).padStart(16, '0')}`,
          path: 'a.ts',
          line: index + 1,
          body: 'x'.repeat(MOBILE_WEB_PROVIDER_REVIEW_SUBMISSION_TOTAL_MAX_CHARACTERS / 8)
        }))
      }).success
    ).toBe(false)
  })

  it('requires content for comment submissions and a summary for requested changes', () => {
    const base = {
      workspaceId: 'repo-1::/workspace',
      expectedHead: repositoryHead,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 17,
      expectedReviewHead: reviewHead,
      submissionId: 'submission_1234567890',
      comments: []
    } as const
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        action: 'comment',
        summary: ''
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        action: 'request-changes',
        summary: ''
      }).success
    ).toBe(false)
    expect(
      MobileWebProviderReviewSubmissionPayloadSchema.safeParse({
        ...base,
        action: 'approve',
        summary: ''
      }).success
    ).toBe(true)
  })

  it('binds completed comment ids to the exact submission', () => {
    expect(
      MobileWebProviderReviewSubmissionResultSchema.parse({
        workspaceId: 'repo-1::/workspace',
        provider: 'gitlab',
        reviewNumber: 17,
        expectedReviewHead: reviewHead,
        submissionId: 'submission_1234567890',
        action: 'comment',
        submittedCommentIds: ['comment_1234567890'],
        outcome: 'completed'
      })
    ).toMatchObject({ provider: 'gitlab', submittedCommentIds: ['comment_1234567890'] })
  })
})
