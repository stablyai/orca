import { describe, expect, it } from 'vitest'
import {
  COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES,
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from './comment-body-submit-state'

describe('comment body submit state', () => {
  it('treats blank bodies as empty without producing submit text', () => {
    expect(hasBoundedCommentBodyText('   \n\t  ')).toBe(false)
    expect(getCommentBodySubmitState('   \n\t  ')).toEqual({ status: 'empty' })
  })

  it('returns trimmed submit text for bounded comment bodies', () => {
    expect(hasBoundedCommentBodyText('  hello world  ')).toBe(true)
    expect(getCommentBodySubmitState('  hello world  ')).toEqual({
      status: 'ready',
      body: 'hello world'
    })
  })

  it('counts multibyte leading whitespace toward the scan budget', () => {
    const oversizedLeadingWhitespace = '\u3000'.repeat(COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES)
    const body = oversizedLeadingWhitespace.concat('body')

    expect(hasBoundedCommentBodyText(body)).toBe(false)
    expect(getCommentBodySubmitState(body)).toEqual({
      status: 'too-large-leading-whitespace'
    })
  })

  it('does not expose oversized pasted whitespace as submit text', () => {
    const oversizedWhitespace = ' '.repeat(COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES + 1)

    expect(hasBoundedCommentBodyText(oversizedWhitespace)).toBe(false)
    expect(getCommentBodySubmitState(oversizedWhitespace)).toEqual({
      status: 'too-large-leading-whitespace'
    })
    expect(JSON.stringify(getCommentBodySubmitState(oversizedWhitespace))).not.toContain(
      oversizedWhitespace
    )
  })
})
