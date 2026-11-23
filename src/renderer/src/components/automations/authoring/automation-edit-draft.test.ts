import { describe, expect, it } from 'vitest'
import { makeAutomation } from '../automations-page-fixtures'
import { buildAutomationEditDraft } from './automation-edit-draft'

describe('buildAutomationEditDraft', () => {
  it('opens an interval rule as Custom, unchanged, with no warning', () => {
    const rrule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'
    expect(buildAutomationEditDraft(makeAutomation({ rrule }))).toMatchObject({
      preset: 'custom',
      customSchedule: rrule,
      scheduleWarning: null
    })
  })
})
