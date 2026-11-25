import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdateFields } from './automation-params'

const create = {
  name: 'Daily',
  prompt: 'Summarize',
  agentId: 'claude',
  rrule: '30 9 * * *',
  dtstart: 0
}

describe('automation timezone params', () => {
  it('refuses an unknown zone the owner named', () => {
    for (const schema of [AutomationCreate, AutomationUpdateFields]) {
      const result = schema.safeParse({
        ...create,
        timezone: 'Mars/Olympus',
        timezoneExplicit: true
      })
      expect(result.error?.issues[0]).toMatchObject({
        path: ['timezone'],
        message: expect.stringMatching(/Unknown time zone "Mars\/Olympus"/)
      })
    }
  })

  it('still saves an unnamed unknown zone and a named known one', () => {
    for (const schema of [AutomationCreate, AutomationUpdateFields]) {
      expect(schema.safeParse({ ...create, timezone: 'Mars/Olympus' }).success).toBe(true)
      expect(
        schema.safeParse({ ...create, timezone: 'America/New_York', timezoneExplicit: true })
          .success
      ).toBe(true)
    }
  })
})
