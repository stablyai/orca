import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS,
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT,
  MobileWebProviderReviewMutationPayloadSchema,
  MobileWebProviderReviewResultSchema
} from './provider-review-contract'

const head = 'a'.repeat(40)

describe('mobile web provider review contract', () => {
  it('accepts a bounded provider-neutral review result', () => {
    expect(
      MobileWebProviderReviewResultSchema.parse({
        workspaceId: 'repo-1::/workspace',
        observedHead: head,
        branch: 'feature/review',
        review: {
          provider: 'gitlab',
          number: 42,
          title: 'Keep provider identity explicit',
          state: 'open',
          checksStatus: 'pending',
          mergeable: 'UNKNOWN',
          reviewDecision: null,
          updatedAt: '2026-07-23T00:00:00.000Z',
          body: 'Description',
          comments: [
            {
              id: '7',
              author: 'ada',
              body: 'Please preserve the SSH path.',
              createdAt: '2026-07-23T00:01:00.000Z',
              kind: 'inline',
              path: 'src/review.ts',
              line: 12,
              threadState: 'open',
              allowedActions: ['set-resolved']
            }
          ],
          commentsTruncated: false,
          files: [],
          filesTruncated: false,
          detailsState: 'loaded',
          canComment: true
        }
      }).review?.provider
    ).toBe('gitlab')
  })

  it('rejects unbounded comments and non-provider identities', () => {
    const comments = Array.from(
      { length: MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT + 1 },
      (_, id) => ({
        id: String(id + 1),
        author: '',
        body: '',
        createdAt: '',
        kind: 'conversation' as const
      })
    )
    const result = MobileWebProviderReviewResultSchema.safeParse({
      workspaceId: 'repo-1::/workspace',
      observedHead: head,
      branch: 'feature/review',
      review: {
        provider: 'custom-forge',
        number: 42,
        title: '',
        state: 'open',
        checksStatus: 'neutral',
        mergeable: 'UNKNOWN',
        reviewDecision: null,
        updatedAt: '',
        body: '',
        comments,
        commentsTruncated: true,
        files: [],
        filesTruncated: false,
        detailsState: 'unsupported',
        canComment: false
      }
    })
    expect(result.success).toBe(false)
  })

  it('rejects duplicate comment ids and review file keys', () => {
    const comment = {
      id: 'duplicate',
      author: 'ada',
      body: 'Comment',
      createdAt: '',
      kind: 'conversation' as const,
      allowedActions: []
    }
    const file = {
      path: 'src/app.ts',
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      isBinary: false,
      commentableLines: [],
      commentableLinesTruncated: false
    }
    expect(
      MobileWebProviderReviewResultSchema.safeParse({
        workspaceId: 'repo-1::/workspace',
        observedHead: head,
        branch: 'feature/review',
        review: {
          provider: 'github',
          number: 42,
          title: 'Review',
          state: 'open',
          checksStatus: 'success',
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          updatedAt: '',
          body: '',
          comments: [comment, comment],
          commentsTruncated: false,
          files: [file, file],
          filesTruncated: false,
          detailsState: 'loaded',
          canComment: true
        }
      }).success
    ).toBe(false)
  })

  it('trims comment mutations and rejects oversized bodies', () => {
    const parsed = MobileWebProviderReviewMutationPayloadSchema.parse({
      workspaceId: 'repo-1::/workspace',
      expectedHead: head,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 17,
      action: 'comment',
      body: '  Ready to merge.  '
    })
    expect(parsed.action).toBe('comment')
    if (parsed.action !== 'comment') {
      throw new Error('expected comment mutation')
    }
    expect(parsed.body).toBe('Ready to merge.')
    expect(
      MobileWebProviderReviewMutationPayloadSchema.safeParse({
        ...parsed,
        body: 'x'.repeat(MOBILE_WEB_PROVIDER_COMMENT_BODY_MAX_CHARACTERS + 1)
      }).success
    ).toBe(false)
  })

  it('keeps reply and thread mutation targets explicit', () => {
    expect(
      MobileWebProviderReviewMutationPayloadSchema.parse({
        workspaceId: 'repo-1::/workspace',
        expectedHead: head,
        expectedBranch: 'feature/review',
        provider: 'github',
        reviewNumber: 17,
        action: 'reply',
        commentId: '9',
        threadId: 'thread-1',
        body: '  Reply body  '
      })
    ).toMatchObject({ action: 'reply', commentId: '9', threadId: 'thread-1', body: 'Reply body' })
    expect(
      MobileWebProviderReviewMutationPayloadSchema.parse({
        workspaceId: 'repo-1::/workspace',
        expectedHead: head,
        expectedBranch: 'feature/review',
        provider: 'gitlab',
        reviewNumber: 17,
        action: 'setThreadResolved',
        threadId: 'discussion-1',
        resolved: true
      })
    ).toMatchObject({ action: 'setThreadResolved', resolved: true })
  })

  it('keeps inline comment review head, path, and line explicit', () => {
    expect(
      MobileWebProviderReviewMutationPayloadSchema.parse({
        workspaceId: 'repo-1::/workspace',
        expectedHead: head,
        expectedBranch: 'feature/review',
        provider: 'github',
        reviewNumber: 17,
        action: 'inlineComment',
        expectedReviewHead: 'b'.repeat(40),
        path: 'src/review.ts',
        line: 12,
        body: '  Keep this bounded.  '
      })
    ).toMatchObject({
      action: 'inlineComment',
      expectedReviewHead: 'b'.repeat(40),
      path: 'src/review.ts',
      line: 12,
      body: 'Keep this bounded.'
    })
    expect(
      MobileWebProviderReviewMutationPayloadSchema.safeParse({
        workspaceId: 'repo-1::/workspace',
        expectedHead: head,
        expectedBranch: 'feature/review',
        provider: 'gitlab',
        reviewNumber: 17,
        action: 'inlineComment',
        expectedReviewHead: 'b'.repeat(40),
        path: '../outside.ts',
        line: 12,
        body: 'No traversal'
      }).success
    ).toBe(false)
  })
})
