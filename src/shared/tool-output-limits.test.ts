import { expect, it } from 'vitest'
import { capToolOutput, pageOfText } from './tool-output-limits'

it('never splits an astral character at a page or truncation boundary', () => {
  const text = `${'a'.repeat(15_999)}\u{1f600}z`
  expect(pageOfText(text).nextOffset).toBe(15_999)
  expect(pageOfText(text, 15_999)).toEqual({ text: '\u{1f600}z', total: 16_002 })
  expect(capToolOutput('ab\u{1f600}z', 'Read a smaller page.', 3)).toBe(
    'ab\n[Orca: truncated at 2 of 5 characters. Read a smaller page.]'
  )
})
