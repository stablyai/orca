import { expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { suggestedBotPurpose } from '../../../../shared/bots/hand-over-workspace'
import { draftOf, identityTooLong } from './new-bot-draft'

const t = ((_key: string, fallback: string) => fallback) as Translate

it('refuses a blank draft whose purpose is over 1,000 characters', () => {
  expect(identityTooLong(undefined, { purpose: 'x'.repeat(1001) }, t)).toBe(true)
  expect(identityTooLong(undefined, { purpose: 'x'.repeat(1000) }, t)).toBe(false)
})

it('refuses a cleared box that would fall back to an over-limit proposal purpose', () => {
  const proposal = { name: 'Old', purpose: 'x'.repeat(1250) }
  expect(identityTooLong(proposal, { purpose: '' }, t)).toBe(true)
})

it('caps a prefilled purpose at 1,000 characters, trimmed and whole', () => {
  expect(draftOf(undefined, 'x'.repeat(1713)).purpose).toBe('x'.repeat(1000))
  expect(draftOf(undefined, `${'a'.repeat(999)}🚀`).purpose).toBe('a'.repeat(999))
  expect(draftOf(undefined, `${' '.repeat(1000)}Triage PRs`).purpose).toBe('Triage PRs')
})

it('cuts a hand-over purpose without splitting a character', () => {
  expect(suggestedBotPurpose({ comment: `${'a'.repeat(999)}🚀`, branch: 'main' })).toBe(
    'a'.repeat(999)
  )
})
