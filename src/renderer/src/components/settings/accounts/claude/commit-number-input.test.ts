import { describe, expect, it } from 'vitest'
import { parseNumberDraft } from './commit-number-input'

describe('parseNumberDraft', () => {
  it('keeps a typed 95 as 95', () => {
    expect(parseNumberDraft('95', 50, 99.9)).toBe(95)
  })
  it('clamps only the finished value', () => {
    expect(parseNumberDraft('9', 50, 99.9)).toBe(50)
    expect(parseNumberDraft('150', 50, 99.9)).toBe(99.9)
  })
  it('treats empty as unset and junk as invalid', () => {
    expect(parseNumberDraft('', 50, 99.9)).toBeUndefined()
    expect(parseNumberDraft('abc', 50, 99.9)).toBeNull()
  })
})
