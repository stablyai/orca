import { describe, expect, it } from 'vitest'
import { makeAutomation } from '../automations-page-fixtures'
import { buildAutomationEditDraft } from './automation-edit-draft'

describe('buildAutomationEditDraft', () => {
  it('opens a saved rule with a dropped part as the cadence it runs, with a warning', () => {
    const draft = buildAutomationEditDraft(
      makeAutomation({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0' })
    )
    expect(draft).toMatchObject({ preset: 'weekly', dayOfWeek: '3', time: '11:00' })
    expect(draft.scheduleWarning).not.toBeNull()
  })
})
