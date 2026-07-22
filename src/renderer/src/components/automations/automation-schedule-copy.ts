import {
  classifyAutomationCronSchedule,
  tryParseAutomationRrule,
  type AutomationCronScheduleClassification
} from '../../../../shared/automation-schedules'
import { translate } from '@/i18n/i18n'

type AutomationScheduleKind = AutomationCronScheduleClassification['kind']

function formatScheduleClockTime(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

function formatScheduleWeekdayName(dayOfWeek: number): string {
  // Why: 2026-01-04 is a Sunday, so offsetting by dayOfWeek yields any weekday's long name.
  return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(
    new Date(2026, 0, 4 + dayOfWeek)
  )
}

function localizeAutomationScheduleKind(
  kind: AutomationScheduleKind,
  hour: number,
  minute: number,
  dayOfWeek: number
): string {
  switch (kind) {
    case 'hourly':
      return translate('automationSchedule.hourly', 'Hourly at :{{minute}}', {
        minute: String(minute).padStart(2, '0')
      })
    case 'daily':
      return translate('automationSchedule.daily', 'Daily at {{time}}', {
        time: formatScheduleClockTime(hour, minute)
      })
    case 'weekdays':
      return translate('automationSchedule.weekdays', 'Weekdays at {{time}}', {
        time: formatScheduleClockTime(hour, minute)
      })
    case 'weekly':
      // Why: matches the raw formatter's `${day}s at ${time}` pluralization (e.g. "Mondays").
      return translate('automationSchedule.weekly', '{{day}} at {{time}}', {
        day: `${formatScheduleWeekdayName(dayOfWeek)}s`,
        time: formatScheduleClockTime(hour, minute)
      })
    case 'custom':
      return translate('automationSchedule.custom', 'Custom schedule')
    case 'invalid':
      return translate('automationSchedule.invalid', 'Invalid schedule')
  }
}

function localizeCronClassification(
  classification: AutomationCronScheduleClassification
): string {
  switch (classification.kind) {
    case 'hourly':
      return localizeAutomationScheduleKind('hourly', 0, classification.minute, 0)
    case 'daily':
      return localizeAutomationScheduleKind('daily', classification.hour, classification.minute, 0)
    case 'weekdays':
      return localizeAutomationScheduleKind(
        'weekdays',
        classification.hour,
        classification.minute,
        0
      )
    case 'weekly':
      return localizeAutomationScheduleKind(
        'weekly',
        classification.hour,
        classification.minute,
        classification.dayOfWeek
      )
    case 'custom':
      return localizeAutomationScheduleKind('custom', 0, 0, 0)
    case 'invalid':
      return localizeAutomationScheduleKind('invalid', 0, 0, 0)
  }
}

// Why: mirrors formatAutomationSchedule's dispatch — RRULE strings are KEY=VALUE pairs, everything else is cron.
export function getLocalizedAutomationScheduleLabel(scheduleExpression: string): string {
  const trimmed = scheduleExpression.trim()
  if (trimmed.includes('=')) {
    const parsed = tryParseAutomationRrule(trimmed)
    if (!parsed) {
      return localizeAutomationScheduleKind('invalid', 0, 0, 0)
    }
    return localizeAutomationScheduleKind(parsed.preset, parsed.hour, parsed.minute, parsed.dayOfWeek)
  }
  return localizeCronClassification(classifyAutomationCronSchedule(trimmed))
}

export type LocalizedAutomationCronScheduleClassification = AutomationCronScheduleClassification & {
  localizedLabel: string
}

// Why: callers that need to branch on schedule kind (e.g. detect "custom") get the kind
// alongside the localized label instead of string-matching a translated value.
export function getLocalizedAutomationCronScheduleClassification(
  schedule: string
): LocalizedAutomationCronScheduleClassification {
  const classification = classifyAutomationCronSchedule(schedule)
  return { ...classification, localizedLabel: localizeCronClassification(classification) }
}
