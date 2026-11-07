import { describe, expect, it } from 'vitest'
import { appendTypedDraftText } from './typed-draft-text'

describe('appendTypedDraftText', () => {
  it('turns line breaks inside a pasted chunk into one space', () => {
    expect(appendTypedDraftText('', 'first line\r\nsecond', 100)).toBe('first line second')
    expect(appendTypedDraftText('typed', '\r', 100)).toBe('typed')
  })

  it('keeps printable text and drops Enter, Tab and control keys', () => {
    expect(appendTypedDraftText('', 'make\tthe tests\x03 pass\r', 100)).toBe('makethe tests pass')
  })

  it('applies Backspace and drops escape sequences', () => {
    expect(appendTypedDraftText('fixx', '\x7f', 100)).toBe('fix')
    expect(appendTypedDraftText('fix', '\x1b[A', 100)).toBe('fix')
  })

  it('stops at the bound', () => {
    expect(appendTypedDraftText('ab', 'cdef', 4)).toBe('abcd')
  })
})
