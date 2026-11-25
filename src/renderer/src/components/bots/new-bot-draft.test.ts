import { expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { draftOf, identityTooLong } from './new-bot-draft'

const t = ((_key: string, fallback: string) => fallback) as Translate

it('refuses a blank draft whose purpose is over 200 characters', () => {
  expect(identityTooLong(undefined, 'x'.repeat(713), t)).toBe(true)
  expect(identityTooLong(undefined, 'x'.repeat(200), t)).toBe(false)
})

it('caps a prefilled purpose at 200 characters, as the box does', () => {
  expect(draftOf(undefined, 'x'.repeat(713)).purpose).toBe('x'.repeat(200))
})
