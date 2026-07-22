import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import {
  buildAutomationCronSchedule,
  buildAutomationRrule,
  formatAutomationSchedule
} from '../../../../shared/automation-schedules'
import {
  getLocalizedAutomationCronScheduleClassification,
  getLocalizedAutomationScheduleLabel
} from './automation-schedule-copy'

function formatTimeForTest(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

describe('automation-schedule-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('matches the raw formatter for every RRULE-based preset', () => {
    const cases: [string, string][] = [
      [buildAutomationRrule({ preset: 'hourly', hour: 9, minute: 5 }), 'hourly'],
      [buildAutomationRrule({ preset: 'daily', hour: 9, minute: 0 }), 'daily'],
      [buildAutomationRrule({ preset: 'weekdays', hour: 9, minute: 30 }), 'weekdays'],
      [buildAutomationRrule({ preset: 'weekly', hour: 16, minute: 45, dayOfWeek: 3 }), 'weekly'],
      [buildAutomationRrule({ preset: 'weekly', hour: 12, minute: 30, dayOfWeek: 0 }), 'weekly-sun']
    ]
    for (const [rrule] of cases) {
      expect(getLocalizedAutomationScheduleLabel(rrule)).toBe(formatAutomationSchedule(rrule))
    }
  })

  it('matches the raw formatter for an unparsable RRULE-shaped expression', () => {
    expect(getLocalizedAutomationScheduleLabel('FREQ=YEARLY')).toBe(
      formatAutomationSchedule('FREQ=YEARLY')
    )
    expect(getLocalizedAutomationScheduleLabel('FREQ=YEARLY')).toBe('Invalid schedule')
  })

  it('matches the raw formatter for every cron-based classification kind', () => {
    const schedules = [
      buildAutomationCronSchedule({ preset: 'hourly', hour: 0, minute: 5 }),
      buildAutomationCronSchedule({ preset: 'daily', hour: 10, minute: 15 }),
      buildAutomationCronSchedule({ preset: 'weekdays', hour: 10, minute: 15 }),
      buildAutomationCronSchedule({ preset: 'weekly', hour: 12, minute: 30, dayOfWeek: 0 }),
      '*/30 9-17 * * MON-FRI', // custom
      '0 0 31 2 *' // invalid: no possible occurrence
    ]
    for (const schedule of schedules) {
      expect(getLocalizedAutomationScheduleLabel(schedule)).toBe(formatAutomationSchedule(schedule))
    }
  })

  it('produces the exact English fallback strings for each distinct schedule kind', () => {
    expect(getLocalizedAutomationScheduleLabel('FREQ=HOURLY;BYMINUTE=5')).toBe('Hourly at :05')
    expect(getLocalizedAutomationScheduleLabel('15 10 * * *')).toBe(
      `Daily at ${formatTimeForTest(10, 15)}`
    )
    expect(getLocalizedAutomationScheduleLabel('15 10 * * MON-FRI')).toBe(
      `Weekdays at ${formatTimeForTest(10, 15)}`
    )
    expect(getLocalizedAutomationScheduleLabel('30 12 * * 7')).toBe(
      `Sundays at ${formatTimeForTest(12, 30)}`
    )
    expect(getLocalizedAutomationScheduleLabel('*/30 9-17 * * MON-FRI')).toBe('Custom schedule')
    expect(getLocalizedAutomationScheduleLabel('0 0 31 2 *')).toBe('Invalid schedule')
  })

  it('translates a valid label when the UI language changes', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(getLocalizedAutomationScheduleLabel('*/30 9-17 * * MON-FRI')).not.toBe(
      'Custom schedule'
    )
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  it('reports the schedule kind alongside the localized label for cron expressions', () => {
    const custom = getLocalizedAutomationCronScheduleClassification('*/30 9-17 * * MON-FRI')
    expect(custom.kind).toBe('custom')
    expect(custom.localizedLabel).toBe('Custom schedule')

    const weekly = getLocalizedAutomationCronScheduleClassification('30 12 * * 7')
    expect(weekly).toMatchObject({ kind: 'weekly', hour: 12, minute: 30, dayOfWeek: 0 })
    expect(weekly.localizedLabel).toBe(`Sundays at ${formatTimeForTest(12, 30)}`)
  })
})
