import { describe, expect, it } from 'vitest'
import { contentContinuesBelow } from './use-content-continues-below'

describe('contentContinuesBelow (composer footer edge)', () => {
  it('is true while fields sit under the sticky footer', () => {
    expect(contentContinuesBelow({ scrollHeight: 900, scrollTop: 0, clientHeight: 600 })).toBe(true)
  })

  it('is false once scrolled to the end, or when nothing overflows', () => {
    expect(contentContinuesBelow({ scrollHeight: 900, scrollTop: 300, clientHeight: 600 })).toBe(
      false
    )
    expect(contentContinuesBelow({ scrollHeight: 500, scrollTop: 0, clientHeight: 600 })).toBe(
      false
    )
  })

  it('ignores sub-pixel rounding at the end', () => {
    expect(contentContinuesBelow({ scrollHeight: 900.5, scrollTop: 300, clientHeight: 600 })).toBe(
      false
    )
  })
})
