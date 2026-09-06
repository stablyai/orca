import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_MAX_ROWS,
  MOBILE_WEB_DIFF_PAGE_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT,
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlDiffResultSchema,
  MobileWebSourceControlStatusResultSchema
} from './source-control-operation-contract'

describe('mobile web source-control operation contract', () => {
  it('bounds status entries and rejects unsafe repository paths', () => {
    expect(
      MobileWebSourceControlStatusResultSchema.safeParse({
        workspaceId: 'workspace-1',
        conflictOperation: 'unknown',
        entries: Array.from({ length: MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT }, (_, index) => ({
          relativePath: `src/file-${index}.ts`,
          status: 'modified',
          area: 'unstaged'
        })),
        totalCount: MOBILE_WEB_SOURCE_CONTROL_STATUS_LIMIT,
        truncated: false
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlStatusResultSchema.safeParse({
        workspaceId: 'workspace-1',
        conflictOperation: 'unknown',
        entries: [{ relativePath: '../secret', status: 'modified', area: 'unstaged' }],
        totalCount: 1,
        truncated: false
      }).success
    ).toBe(false)
  })

  it('bounds diff pages, rows, and revision continuations', () => {
    expect(
      MobileWebSourceControlDiffPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        offset: MOBILE_WEB_DIFF_MAX_ROWS,
        limit: MOBILE_WEB_DIFF_PAGE_LIMIT,
        expectedRevision: 'a'.repeat(64)
      }).success
    ).toBe(true)
    expect(
      MobileWebSourceControlDiffResultSchema.safeParse({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        kind: 'text',
        revision: 'a'.repeat(64),
        offset: 0,
        totalRows: 1,
        rows: [
          {
            index: 0,
            kind: 'add',
            text: 'x'.repeat(MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS + 1),
            textTruncated: false,
            newLineNumber: 1
          }
        ],
        nextOffset: null,
        truncated: false
      }).success
    ).toBe(false)
  })

  it('represents binary and oversized results without repository bytes', () => {
    expect(
      MobileWebSourceControlDiffResultSchema.parse({
        workspaceId: 'workspace-1',
        relativePath: 'logo.png',
        area: 'staged',
        kind: 'binary'
      })
    ).toMatchObject({ kind: 'binary' })
    expect(
      MobileWebSourceControlDiffResultSchema.parse({
        workspaceId: 'workspace-1',
        relativePath: 'generated.ts',
        area: 'unstaged',
        kind: 'too-large',
        reason: 'mobile-limit',
        characterCount: 3_000_000
      })
    ).toMatchObject({ kind: 'too-large' })
  })
})
