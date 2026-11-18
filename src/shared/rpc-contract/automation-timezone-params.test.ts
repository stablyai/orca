import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdateFields } from './automations/automation-params'

const CREATE = {
  name: 'Morning',
  prompt: 'Summarize',
  agentId: 'claude',
  workspaceMode: 'new_per_run',
  timezone: 'Europe/London',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1
}

describe('a named zone across Orca versions', () => {
  it('reaches a host that knows it, on create and edit', () => {
    expect(AutomationCreate.parse({ ...CREATE, timezoneExplicit: true })).toMatchObject({
      timezoneExplicit: true
    })
    expect(AutomationUpdateFields.parse({ timezoneExplicit: true })).toEqual({
      timezoneExplicit: true
    })
  })

  it('is absent from an older client, which a host reads as the default zone', () => {
    expect(AutomationCreate.parse(CREATE)).not.toHaveProperty('timezoneExplicit')
  })

  it('is dropped, not refused, by an older host, which keeps scheduling as it does today', () => {
    const olderCreate = AutomationCreate.omit({ timezoneExplicit: true })
    const olderUpdate = AutomationUpdateFields.omit({ timezoneExplicit: true })

    expect(olderCreate.parse({ ...CREATE, timezoneExplicit: true })).not.toHaveProperty(
      'timezoneExplicit'
    )
    expect(olderUpdate.parse({ timezone: 'Asia/Tokyo', timezoneExplicit: true })).toEqual({
      timezone: 'Asia/Tokyo'
    })
  })
})
