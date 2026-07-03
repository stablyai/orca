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
  it('preserves small comment context and nearest brace block behavior', () => {
    const source = ['function outer() {', '  if (ready) {', '    run()', '  }', '}', 'after'].join(
      '\n'
    )

    const context = getContext(source, 3)

    expect(context).toMatchObject({
      selectedLines: ['    run()'],
      totalLines: 6,
      commentFrom: 3,
      commentTo: 3,
      from: 3,
      to: 3,
      blockRange: { startLine: 2, endLine: 4 },
      shouldUseBlockRange: true,
      canExpandAbove: true,
      canExpandBelow: true,
      canExpandBlock: true
    })
  })

  it('normalizes CRLF line endings like the previous split path', () => {
    const context = getContext('one\r\ntwo\r\nthree', 2, 1, 1)

    expect(context?.selectedLines).toEqual(['one', 'two', 'three'])
    expect(context?.totalLines).toBe(3)
  })

  it('extracts newline-heavy context without splitting the full source', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const source = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`).join('\n')

    const context = getContext(source, 4_995, 2, 2)

    expect(context?.selectedLines).toEqual([
      'line 4993',
      'line 4994',
      'line 4995',
      'line 4996',
      'line 4997'
    ])
    expect(split).not.toHaveBeenCalled()
  })

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
