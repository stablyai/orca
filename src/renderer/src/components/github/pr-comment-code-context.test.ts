import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PR_COMMENT_CODE_CONTEXT_BLOCK_SCAN_CODE_UNITS,
  PR_COMMENT_CODE_CONTEXT_LINE_MAX_CODE_UNITS,
  getPrCommentCodeContext
} from './pr-comment-code-context'

const FALLBACK_LINES = 20
const MAX_BLOCK_LINES = 41

afterEach(() => {
  vi.restoreAllMocks()
})

function getContext(source: string, line: number, contextBefore = 0, contextAfter = 0) {
  return getPrCommentCodeContext({
    source,
    line,
    startLine: null,
    contextBefore,
    contextAfter,
    fallbackLines: FALLBACK_LINES,
    maxBlockLines: MAX_BLOCK_LINES
  })
}

describe('getPrCommentCodeContext', () => {
  it('caps pathological single-line excerpts and skips optional block scanning for huge files', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const source = '{'.repeat(PR_COMMENT_CODE_CONTEXT_BLOCK_SCAN_CODE_UNITS + 10_000)

    const context = getContext(source, 1)

    expect(context?.selectedLines).toEqual([
      '{'.repeat(PR_COMMENT_CODE_CONTEXT_LINE_MAX_CODE_UNITS)
    ])
    expect(context?.shouldUseBlockRange).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })
})
