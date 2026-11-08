import { describe, expect, it } from 'vitest'
import {
  COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES,
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from './comment-body-submit-state'

describe('comment body submit state', () => {
  it('counts multibyte leading whitespace toward the scan budget', () => {
    const oversizedLeadingWhitespace = '\u3000'.repeat(
      Math.floor(COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES / 3) + 1
    )
    const body = oversizedLeadingWhitespace.concat('body')

    expect(hasBoundedCommentBodyText(body)).toBe(false)
    expect(getCommentBodySubmitState(body)).toEqual({
      status: 'too-large-leading-whitespace'
    })
  })
})
