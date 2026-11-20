import { describe, expect, it } from 'vitest'
import { assertGoogleTrigger } from './automation-google-triggers'

describe('Google rule checks', () => {
  it('takes 0 to a day of minutes before a meeting', () => {
    const rule = { id: 'm', source: 'calendar', event: 'starting_soon' } as const
    expect(() => assertGoogleTrigger({ ...rule, minutesBefore: 0 })).not.toThrow()
    expect(() => assertGoogleTrigger({ ...rule, minutesBefore: 1441 })).toThrow('0 to 1440')
    expect(() => assertGoogleTrigger({ ...rule, minutesBefore: 2.5 })).toThrow('0 to 1440')
  })

  it('caps how many addresses and how long a filter a Gmail rule has', () => {
    const rule = { id: 'g', source: 'gmail', event: 'new_email' } as const
    const many = Array.from({ length: 11 }, (_, index) => `p${index}@acme.com`)
    expect(() => assertGoogleTrigger({ ...rule, from: many })).toThrow('too long')
    expect(() => assertGoogleTrigger({ ...rule, subjectContains: 'x'.repeat(201) })).toThrow(
      'too long'
    )
  })
})
