import { describe, expect, it } from 'vitest'
import { shortDigest } from './skill-package-digest'

describe('shortDigest', () => {
  // Why: a full 64-char digest on one nowrap line is wider than any dialog, and
  // as a grid item it drags the whole dialog into horizontal scrolling.
  it('keeps both ends so a digest stays comparable at a glance', () => {
    expect(shortDigest(`${'a'.repeat(58)}bcdef1`)).toBe('aaaaaaaa…bcdef1')
    expect(shortDigest('a'.repeat(64)).length).toBeLessThan(20)
  })

  it('leaves an already short value alone', () => {
    expect(shortDigest('abc123')).toBe('abc123')
  })
})
