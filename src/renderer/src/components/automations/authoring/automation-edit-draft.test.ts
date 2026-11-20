import { describe, expect, it } from 'vitest'
import { makeAutomation } from '../automations-page-fixtures'
import { buildAutomationEditDraft } from './automation-edit-draft'

describe('buildAutomationEditDraft', () => {
  it('opens an interval rule as Custom, unchanged, with no warning', () => {
    const rrule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'
    expect(buildAutomationEditDraft(makeAutomation({ rrule }))).toMatchObject({
      preset: 'custom',
      customSchedule: rrule,
      savedSchedule: rrule,
      scheduleWarning: null
    })
  })

  it('opens a refused saved rule as Custom with the part named, so a rename still saves', () => {
    const rrule = 'FREQ=WEEKLY;WKST=MO;BYDAY=WE'
    const draft = buildAutomationEditDraft(makeAutomation({ rrule }))
    expect(draft).toMatchObject({ preset: 'custom', customSchedule: rrule, savedSchedule: rrule })
    expect(draft.scheduleWarning).toContain('"WKST"')
  })
})
