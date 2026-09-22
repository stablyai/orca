import { describe, expect, it } from 'vitest'
import { parseBareItemNumber } from './work-item-number'

describe('parseBareItemNumber', () => {
  it.each([
    ['42', 42],
    ['#42', 42],
    ['1', 1]
  ])('parses %s', (input, expected) => {
    expect(parseBareItemNumber(input)).toBe(expected)
  })

  it.each(['', '#', '0', '#0', '-1', '4 2', '42x', '!42', 'STA-335', 'https://x/1'])(
    'rejects %s',
    (input) => {
      expect(parseBareItemNumber(input)).toBeNull()
    }
  )

  // Why: `/^\d+$/` accepts 400 digits, which parseInt turns into Infinity — the
  // save gate would enable and JSON.stringify would persist `null`.
  it('rejects a number past the safe-integer range', () => {
    expect(parseBareItemNumber('9'.repeat(400))).toBeNull()
  })
})
