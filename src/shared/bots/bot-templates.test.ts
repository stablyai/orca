import { describe, expect, it } from 'vitest'
import { automationEventKind } from '../automation-event-triggers'
import { isValidAutomationSchedule } from '../automations/scheduling/automation-schedule-parsing'
import { describeAutomationSchedule } from '../automations/scheduling/automation-schedules'
import { BOT_TEMPLATES } from './bot-templates'

// Each English line a template shows, and the schedule it must be.
const WHEN: Record<string, { kind: string; cron?: string } & Record<string, unknown>> = {
  'Mondays at 9 AM': { kind: 'weekly', hour: 9, minute: 0, dayOfWeek: 1 },
  'Wednesdays at 10 AM': { kind: 'weekly', hour: 10, minute: 0, dayOfWeek: 3 },
  'Fridays at 3 PM': { kind: 'weekly', hour: 15, minute: 0, dayOfWeek: 5 },
  'Fridays at 4 PM': { kind: 'weekly', hour: 16, minute: 0, dayOfWeek: 5 },
  'Weekdays at 9 AM': { kind: 'weekdays', hour: 9, minute: 0 },
  'Weekdays at 2 PM': { kind: 'weekdays', hour: 14, minute: 0 },
  'Daily at 4 PM': { kind: 'daily', hour: 16, minute: 0 },
  'Weekdays, every 2 hours from 9 AM to 5 PM': { kind: 'custom', cron: '0 9-17/2 * * 1-5' },
  '1st of each month at 9 AM': { kind: 'custom', cron: '0 9 1 * *' }
}

describe('the template catalog', () => {
  it('makes only schedules the scheduler runs, each as its English line says', () => {
    const schedules = BOT_TEMPLATES.flatMap((template) => template.schedules)
    expect(schedules.length).toBeGreaterThan(0)
    for (const schedule of schedules) {
      expect(isValidAutomationSchedule(schedule.rrule), schedule.when).toBe(true)
      const expected = WHEN[schedule.when]
      expect(expected, schedule.when).toBeDefined()
      if (expected?.cron) {
        expect(schedule.rrule).toBe(expected.cron)
      } else {
        expect(describeAutomationSchedule(schedule.rrule)).toEqual(expected)
      }
    }
  })

  it('offers only events Orca can start an automation on', () => {
    for (const { source, event } of BOT_TEMPLATES.flatMap((template) => template.events)) {
      expect(automationEventKind(source, event), `${source}.${event}`).not.toBeNull()
    }
  })
})
