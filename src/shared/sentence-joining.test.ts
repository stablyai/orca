import { expect, it } from 'vitest'
import { joinSentences } from './sentence-joining'

it('does not append a CJK full stop to an English sentence containing a CJK name', () => {
  expect(joinSentences(["Couldn't confirm 日本語 started", 'Try again'])).toBe(
    "Couldn't confirm 日本語 started Try again"
  )
})
