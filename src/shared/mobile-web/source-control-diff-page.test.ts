import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS,
  MOBILE_WEB_DIFF_MAX_ROWS
} from './source-control-operation-contract'
import { buildMobileWebSourceControlDiffPage } from './source-control-diff-page'

const BASE = {
  workspaceId: 'workspace-1',
  relativePath: 'src/app.ts',
  area: 'unstaged' as const,
  revision: 'a'.repeat(64)
}

describe('mobile web source-control diff page', () => {
  it('builds deterministic numbered rows and pages them without raw source retention', () => {
    const result = buildMobileWebSourceControlDiffPage({
      ...BASE,
      originalContent: 'before\nsame\n',
      modifiedContent: 'after\nsame\n',
      offset: 0,
      limit: 2
    })

    expect(result).toMatchObject({
      kind: 'text',
      offset: 0,
      totalRows: 3,
      nextOffset: 2,
      truncated: false,
      rows: [
        { index: 0, kind: 'delete', text: 'before', oldLineNumber: 1 },
        { index: 1, kind: 'add', text: 'after', newLineNumber: 1 }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('originalContent')
  })

  it('caps a real 4,000-row window and exposes the final bounded page', () => {
    const modifiedContent = Array.from(
      { length: MOBILE_WEB_DIFF_MAX_ROWS + 50 },
      (_, index) => `line ${index}`
    ).join('\n')
    const result = buildMobileWebSourceControlDiffPage({
      ...BASE,
      originalContent: '',
      modifiedContent,
      offset: MOBILE_WEB_DIFF_MAX_ROWS - 10,
      limit: 20
    })

    expect(result).toMatchObject({
      kind: 'text',
      offset: MOBILE_WEB_DIFF_MAX_ROWS - 10,
      totalRows: MOBILE_WEB_DIFF_MAX_ROWS,
      nextOffset: null,
      truncated: true
    })
    if (result.kind === 'text') {
      expect(result.rows).toHaveLength(10)
      expect(result.rows.at(-1)?.index).toBe(MOBILE_WEB_DIFF_MAX_ROWS - 1)
    }
  })

  it('caps individual lines and rejects oversized source documents before diffing', () => {
    const lineResult = buildMobileWebSourceControlDiffPage({
      ...BASE,
      originalContent: '',
      modifiedContent: 'x'.repeat(MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS + 10),
      offset: 0,
      limit: 1
    })
    expect(lineResult).toMatchObject({
      kind: 'text',
      rows: [
        {
          text: 'x'.repeat(MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS),
          textTruncated: true
        }
      ]
    })

    expect(
      buildMobileWebSourceControlDiffPage({
        ...BASE,
        originalContent: 'x'.repeat(MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS),
        modifiedContent: 'y',
        offset: 0,
        limit: 1
      })
    ).toMatchObject({
      kind: 'too-large',
      reason: 'mobile-limit',
      characterCount: MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS + 1
    })
  })
})
