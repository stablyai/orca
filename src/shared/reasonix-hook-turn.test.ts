import { expect, it } from 'vitest'
import { normalizeReasonixPromptId } from './reasonix-hook-turn'

const id = '985b66b859ffae5cd8d17ef63ec3d33c'
it('keeps the native session spelling and positive integer turn identity', () => {
  expect(normalizeReasonixPromptId(`${id}:12`, id)).toBe(`${id}:12`)
  expect(normalizeReasonixPromptId(`${id}:12`, 'another-id')).toBeUndefined()
})
it.each([
  undefined,
  12,
  `${id}:0`,
  `${id}:-1`,
  `${id}:01`,
  `${id}:1.5`,
  `${id}:1e2`,
  `${id}:9007199254740992`,
  '../bad:1',
  `${id}:1\n`
])('refuses unsafe native turn identity %j', (value) =>
  expect(normalizeReasonixPromptId(value)).toBeUndefined()
)
