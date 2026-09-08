import { describe, expect, it } from 'vitest'
import {
  MobileWebProviderReviewDiffPayloadSchema,
  MobileWebProviderReviewDiffResultSchema
} from './provider-review-diff-contract'

const HEAD = 'a'.repeat(40)
const REVIEW_HEAD = 'b'.repeat(40)

describe('mobile web provider review diff contract', () => {
  it('accepts exact review identity and a bounded focused page', () => {
    const result = MobileWebProviderReviewDiffResultSchema.parse({
      workspaceId: 'repo::workspace',
      observedHead: HEAD,
      branch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      reviewHead: REVIEW_HEAD,
      path: 'src/review.ts',
      kind: 'text',
      revision: 'c'.repeat(64),
      offset: 48,
      totalRows: 120,
      rows: [
        {
          index: 48,
          kind: 'add',
          text: 'focused',
          textTruncated: false,
          newLineNumber: 87
        }
      ],
      nextOffset: 49,
      truncated: false,
      focusLine: 87,
      focusRowIndex: 48
    })
    expect(result.kind).toBe('text')
    expect(result.kind === 'text' ? result.focusRowIndex : undefined).toBe(48)
  })

  it('rejects traversal, unbounded pages, and incomplete focused results', () => {
    const base = {
      workspaceId: 'repo::workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'gitlab',
      reviewNumber: 7,
      expectedReviewHead: REVIEW_HEAD,
      path: 'src/review.ts'
    }
    expect(() =>
      MobileWebProviderReviewDiffPayloadSchema.parse({ ...base, path: '../secret', limit: 96 })
    ).toThrow()
    expect(() => MobileWebProviderReviewDiffPayloadSchema.parse({ ...base, limit: 97 })).toThrow()
    expect(() =>
      MobileWebProviderReviewDiffPayloadSchema.parse({
        ...base,
        offset: 96,
        expectedRevision: 'd'.repeat(64),
        focusLine: 100
      })
    ).toThrow()
    expect(() =>
      MobileWebProviderReviewDiffResultSchema.parse({
        workspaceId: 'repo::workspace',
        observedHead: HEAD,
        branch: 'feature/review',
        provider: 'gitlab',
        reviewNumber: 7,
        reviewHead: REVIEW_HEAD,
        path: 'src/review.ts',
        kind: 'text',
        revision: 'c'.repeat(64),
        offset: 0,
        totalRows: 1,
        rows: [],
        nextOffset: null,
        truncated: false,
        focusLine: 87,
        focusRowIndex: 0
      })
    ).toThrow()
  })
})
