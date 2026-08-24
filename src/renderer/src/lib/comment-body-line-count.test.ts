import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMENT_BODY_LAYOUT_MAX_LINES,
  COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS,
  getCommentBodyLayoutLineCount,
  getReviewThreadLayoutLineCount
} from './comment-body-line-count'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('comment body layout line count', () => {
  it('matches normal newline counts used for comment layout', () => {
    expect(getCommentBodyLayoutLineCount('')).toBe(1)
    expect(getCommentBodyLayoutLineCount('one line')).toBe(1)
    expect(getCommentBodyLayoutLineCount('one\ntwo\nthree')).toBe(3)
    expect(getCommentBodyLayoutLineCount('one\r\ntwo')).toBe(2)
  })

  it('caps newline-heavy pasted comments without splitting the body', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')

    expect(getCommentBodyLayoutLineCount('\n'.repeat(100_000))).toBe(COMMENT_BODY_LAYOUT_MAX_LINES)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(128)
  })

  it('bounds long single-line comment scans used only for layout estimates', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const body = 'x'.repeat(COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS + 10_000)

    expect(getCommentBodyLayoutLineCount(body)).toBe(1)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBe(COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS)
  })
})

describe('getReviewThreadLayoutLineCount', () => {
  it('estimates thread height from root plus replies', () => {
    const root = 'line1\nline2'
    const single = getCommentBodyLayoutLineCount(root)
    const total = getReviewThreadLayoutLineCount({
      body: root,
      reviewThread: {
        isResolved: false,
        replies: [{ body: 'a\nb\nc' }, { body: 'd' }]
      }
    })
    expect(total).toBeGreaterThan(single + 4)
  })

  it('estimates collapsed resolved threads as a single row', () => {
    const total = getReviewThreadLayoutLineCount({
      body: 'x\n'.repeat(30),
      reviewThread: { isResolved: true, replies: [] }
    })
    expect(total).toBeLessThanOrEqual(2)
  })

  it('falls back to the plain body estimate without thread data', () => {
    const body = 'one\ntwo\nthree'
    expect(getReviewThreadLayoutLineCount({ body })).toBe(getCommentBodyLayoutLineCount(body))
  })
})
