import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_REVIEW_COMMENT_LIMIT,
  MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS,
  MOBILE_WEB_REVIEW_FILE_STATE_LIMIT,
  MobileWebSourceControlReviewDiffPayloadSchema,
  MobileWebSourceControlReviewMetadataResultSchema,
  MobileWebSourceControlReviewMetadataUpdatePayloadSchema
} from './source-control-review-contract'

const workspaceId = 'workspace-1'
const revision = 'a'.repeat(64)

describe('mobile web source-control review contract', () => {
  it('accepts bounded metadata without host workspace identity', () => {
    const result = MobileWebSourceControlReviewMetadataResultSchema.parse({
      workspaceId,
      revision,
      comments: [
        {
          id: 'note-1',
          relativePath: 'src/app.ts',
          lineNumber: 4,
          body: 'Review this',
          createdAt: 1,
          scope: 'unstaged',
          side: 'modified'
        }
      ],
      reviewState: {
        version: 1,
        files: [
          {
            key: 'unstaged:src/app.ts',
            relativePath: 'src/app.ts',
            scope: 'unstaged'
          }
        ]
      }
    })

    expect(JSON.stringify(result)).not.toContain('worktreeId')
    expect(result.comments[0]?.relativePath).toBe('src/app.ts')
  })

  it('requires exact branch identity only for branch diffs', () => {
    expect(
      MobileWebSourceControlReviewDiffPayloadSchema.safeParse({
        workspaceId,
        relativePath: 'src/app.ts',
        scope: 'branch',
        offset: 0,
        limit: 20
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewDiffPayloadSchema.safeParse({
        workspaceId,
        relativePath: 'src/app.ts',
        scope: 'unstaged',
        compare: {
          baseRef: 'main',
          headOid: 'b'.repeat(40),
          mergeBase: 'a'.repeat(40)
        },
        offset: 0,
        limit: 20
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewDiffPayloadSchema.safeParse({
        workspaceId,
        relativePath: 'src/app.ts',
        scope: 'branch',
        compare: {
          baseRef: 'main',
          headOid: 'b'.repeat(40),
          mergeBase: 'a'.repeat(40)
        },
        offset: 0,
        limit: 20
      }).success
    ).toBe(true)
  })

  it('rejects traversal, excess notes, and unversioned writes', () => {
    const comment = {
      id: 'note',
      relativePath: 'src/app.ts',
      lineNumber: 1,
      body: 'body',
      createdAt: 1,
      side: 'modified'
    }
    expect(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema.safeParse({
        workspaceId,
        expectedRevision: revision,
        comments: [{ ...comment, relativePath: '../secret' }],
        reviewState: { version: 1, files: [] }
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema.safeParse({
        workspaceId,
        expectedRevision: revision,
        comments: [{ ...comment, body: 'x'.repeat(MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS + 1) }],
        reviewState: { version: 1, files: [] }
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema.safeParse({
        workspaceId,
        expectedRevision: revision,
        comments: [],
        reviewState: {
          version: 1,
          files: Array.from({ length: MOBILE_WEB_REVIEW_FILE_STATE_LIMIT + 1 }, (_, index) => ({
            key: `unstaged:src/${index}.ts`,
            relativePath: `src/${index}.ts`,
            scope: 'unstaged'
          }))
        }
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema.safeParse({
        workspaceId,
        expectedRevision: revision,
        comments: Array.from({ length: MOBILE_WEB_REVIEW_COMMENT_LIMIT + 1 }, () => comment),
        reviewState: { version: 1, files: [] }
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema.safeParse({
        workspaceId,
        comments: [],
        reviewState: { version: 1, files: [] }
      }).success
    ).toBe(false)
    expect(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema.safeParse({
        workspaceId,
        expectedRevision: revision,
        comments: [
          { ...comment, id: 'duplicate' },
          { ...comment, id: 'duplicate' }
        ],
        reviewState: {
          version: 1,
          files: [
            { key: 'duplicate', relativePath: 'src/app.ts', scope: 'unstaged' },
            { key: 'duplicate', relativePath: 'src/other.ts', scope: 'unstaged' }
          ]
        }
      }).success
    ).toBe(false)
  })
})
