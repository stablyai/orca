import { describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { currentStepCopy } from './cloud-setup-page-copy'

const t: Translate = (_key, fallback) => fallback

describe('CAP-GATE-DESKTOP copy', () => {
  const current = { id: 'plan', state: 'needed', need: 'capability' } as const

  it('offers "contact us" only when [Contact us] is shown', () => {
    const withLink = currentStepCopy(
      { current, action: 'capability-off', contactUrl: 'https://orca.dev/enterprise' },
      t
    )
    expect(withLink.title).toBe('Orca Cloud isn’t turned on for your team yet')
    expect(withLink.lead).toBe(
      'Your team has a plan, but Orca Cloud isn’t turned on for it yet. Try again in a few minutes, or contact us and we’ll turn it on.'
    )
  })

  it('drops "contact us" when the catalog has no contact URL', () => {
    const withoutLink = currentStepCopy({ current, action: 'capability-off', contactUrl: null }, t)
    expect(withoutLink.lead).toBe(
      'Your team has a plan, but Orca Cloud isn’t turned on for it yet. Try again in a few minutes.'
    )
    expect(withoutLink.lead).not.toMatch(/contact/i)
  })
})
