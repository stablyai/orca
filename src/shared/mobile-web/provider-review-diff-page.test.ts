import { describe, expect, it } from 'vitest'
import {
  buildMobileWebProviderReviewContentDiffPage,
  buildMobileWebProviderReviewPatchDiffPage
} from './provider-review-diff-page'

const identity = {
  workspaceId: 'repo::workspace',
  observedHead: 'a'.repeat(40),
  branch: 'feature/review',
  provider: 'gitlab' as const,
  reviewNumber: 42,
  reviewHead: 'b'.repeat(40),
  path: 'src/review.ts',
  revision: 'c'.repeat(64),
  offset: 0,
  limit: 2
}

describe('mobile web provider review diff pages', () => {
  it('parses bounded GitLab patch rows without retaining patch headers', () => {
    const result = buildMobileWebProviderReviewPatchDiffPage({
      ...identity,
      patch: [
        'diff --git a/src/review.ts b/src/review.ts',
        'index 123..456 100644',
        '@@ -10,3 +10,4 @@',
        ' context',
        '-removed',
        '+added',
        '+second',
        ' tail'
      ].join('\n')
    })
    expect(result).toMatchObject({
      kind: 'text',
      offset: 0,
      totalRows: 5,
      nextOffset: 2,
      rows: [
        {
          index: 0,
          kind: 'context',
          text: 'context',
          oldLineNumber: 10,
          newLineNumber: 10
        },
        { index: 1, kind: 'delete', text: 'removed', oldLineNumber: 11 }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('diff --git')
    expect(JSON.stringify(result)).not.toContain('index 123')
  })

  it('anchors an initial page around an exact modified-side line', () => {
    const patch = [
      '@@ -1,8 +1,8 @@',
      ' one',
      ' two',
      ' three',
      '-old',
      '+new',
      ' five',
      ' six',
      ' seven'
    ].join('\n')
    const result = buildMobileWebProviderReviewPatchDiffPage({
      ...identity,
      limit: 3,
      focusLine: 4,
      patch
    })
    expect(result).toMatchObject({
      kind: 'text',
      offset: 3,
      focusLine: 4,
      focusRowIndex: 4
    })
    if (result.kind !== 'text') {
      throw new Error('Expected text diff')
    }
    expect(result.rows.map((row) => row.index)).toEqual([3, 4, 5])
    expect(result.rows.find((row) => row.index === result.focusRowIndex)?.text).toBe('new')
  })

  it('builds paginated GitHub content rows and enforces the mobile input limit', () => {
    const result = buildMobileWebProviderReviewContentDiffPage({
      ...identity,
      provider: 'github',
      originalContent: 'one\nold\nthree\n',
      modifiedContent: 'one\nnew\nthree\n'
    })
    expect(result).toMatchObject({
      kind: 'text',
      offset: 0,
      totalRows: 4,
      nextOffset: 2
    })

    const tooLarge = buildMobileWebProviderReviewContentDiffPage({
      ...identity,
      provider: 'github',
      originalContent: 'x'.repeat(2_000_001),
      modifiedContent: ''
    })
    expect(tooLarge).toMatchObject({
      kind: 'too-large',
      reason: 'mobile-limit',
      characterCount: 2_000_001
    })
  })

  it('caps retained patch rows and individual line text before pagination', () => {
    const result = buildMobileWebProviderReviewPatchDiffPage({
      ...identity,
      limit: 96,
      patch: [
        '@@ -1,4001 +1,4001 @@',
        `+${'x'.repeat(1_200)}`,
        ...Array.from({ length: 4_000 }, () => '+x')
      ].join('\n')
    })
    expect(result).toMatchObject({ kind: 'text', totalRows: 4_000, truncated: true })
    if (result.kind !== 'text') {
      throw new Error('Expected text diff')
    }
    expect(result.rows[0]).toMatchObject({
      index: 0,
      text: 'x'.repeat(1_024),
      textTruncated: true
    })
    expect(result.rows).toHaveLength(96)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(128 * 1024)
  })
})
