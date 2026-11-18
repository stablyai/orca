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
})
