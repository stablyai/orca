import {
  parseAutomationRrule,
  parseCronExpression,
  parseSchedule,
  type ParsedCron
} from './automation-schedule-parsing'
import { cronHasPossibleOccurrence } from './automation-cron-occurrence'

export type AutomationCronScheduleClassification =
  | { kind: 'hourly'; minute: number; label: string }
  | { kind: 'daily'; hour: number; minute: number; label: string }
  | { kind: 'weekdays'; hour: number; minute: number; label: string }
  | { kind: 'weekly'; hour: number; minute: number; dayOfWeek: number; label: string }
  | { kind: 'custom'; label: string }
  | { kind: 'invalid'; label: string }

/** Locale-free schedule shape: the renderer localizes it, the CLI renders it in English. */
export type AutomationScheduleDescriptor =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; dayOfWeek: number }
  | { kind: 'custom' }
  | { kind: 'invalid' }

// Why: shared labels feed the CLI, which must stay English regardless of OS or UI locale.
const EN_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

/** Clock-time portion of a schedule label; numeric shape follows the OS region by convention. */
export function formatAutomationScheduleTime(hour: number, minute: number): string {
  return formatTime(hour, minute)
}

function formatTime(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function getSingleSetValue(values: Set<number>): number | null {
  if (values.size !== 1) {
    return null
  }
  return values.values().next().value as number
}

function setContainsExactly(values: Set<number>, expected: readonly number[]): boolean {
  if (values.size !== expected.length) {
    return false
  }
  return expected.every((value) => values.has(value))
}

function setContainsRange(values: Set<number>, min: number, max: number): boolean {
  if (values.size !== max - min + 1) {
    return false
  }
  for (let value = min; value <= max; value += 1) {
    if (!values.has(value)) {
      return false
    }
  }
  return true
}

function formatParsedRruleSchedule(schedule: ReturnType<typeof parseAutomationRrule>): string {
  if (schedule.preset === 'hourly') {
    return `Hourly at :${String(schedule.minute).padStart(2, '0')}`
  }
  const time = formatTime(schedule.hour, schedule.minute)
  if (schedule.preset === 'daily') {
    return `Daily at ${time}`
  }
  if (schedule.preset === 'weekdays') {
    return `Weekdays at ${time}`
  }
  return `${EN_DAY_NAMES[schedule.dayOfWeek]}s at ${time}`
}

function classifyParsedCronSchedule(rule: ParsedCron): AutomationCronScheduleClassification {
  if (!cronHasPossibleOccurrence(rule, Date.now())) {
    return { kind: 'invalid', label: 'Invalid schedule' }
  }
  const minute = getSingleSetValue(rule.minutes)
  const hour = getSingleSetValue(rule.hours)
  const unrestrictedDayOfMonth = !rule.dayOfMonthRestricted
  const unrestrictedMonth = setContainsRange(rule.months, 1, 12)
  const unrestrictedDayOfWeek = !rule.dayOfWeekRestricted
  const unrestrictedCalendar = unrestrictedDayOfMonth && unrestrictedMonth
  if (
    minute !== null &&
    setContainsRange(rule.hours, 0, 23) &&
    unrestrictedCalendar &&
    unrestrictedDayOfWeek
  ) {
    return {
      kind: 'hourly',
      minute,
      label: `Hourly at :${String(minute).padStart(2, '0')}`
    }
  }
  if (minute !== null && hour !== null && unrestrictedCalendar) {
    const time = formatTime(hour, minute)
    if (unrestrictedDayOfWeek) {
      return { kind: 'daily', hour, minute, label: `Daily at ${time}` }
    }
    if (setContainsExactly(rule.daysOfWeek, [1, 2, 3, 4, 5])) {
      return { kind: 'weekdays', hour, minute, label: `Weekdays at ${time}` }
    }
    const dayOfWeek = getSingleSetValue(rule.daysOfWeek)
    if (dayOfWeek !== null) {
      return {
        kind: 'weekly',
        hour,
        minute,
        dayOfWeek,
        label: `${EN_DAY_NAMES[dayOfWeek]}s at ${time}`
      }
    }
  }
  return { kind: 'custom', label: 'Custom schedule' }
}

export function classifyAutomationCronSchedule(
  schedule: string
): AutomationCronScheduleClassification {
  try {
    return classifyParsedCronSchedule(parseCronExpression(schedule.trim()))
  } catch {
    return { kind: 'invalid', label: 'Invalid schedule' }
  }
}

export function formatAutomationSchedule(scheduleExpression: string): string {
  try {
    const trimmed = scheduleExpression.trim()
    const schedule = parseSchedule(trimmed)
    if (schedule.kind === 'cron') {
      return classifyParsedCronSchedule(schedule).label
    }
    return formatParsedRruleSchedule(parseAutomationRrule(trimmed))
  } catch {
    return 'Invalid schedule'
  }
}

function toScheduleDescriptor(
  classification: AutomationCronScheduleClassification
): AutomationScheduleDescriptor {
  const { label: _label, ...descriptor } = classification
  return descriptor
}

/**
 * Parse a cron or RRULE expression into its locale-free shape so callers can render their own
 * copy. Same single parse path as `formatAutomationSchedule`, minus the English label.
 */
export function describeAutomationSchedule(
  scheduleExpression: string
): AutomationScheduleDescriptor {
  try {
    const trimmed = scheduleExpression.trim()
    const schedule = parseSchedule(trimmed)
    if (schedule.kind === 'cron') {
      return toScheduleDescriptor(classifyParsedCronSchedule(schedule))
    }
    const rrule = parseAutomationRrule(trimmed)
    if (rrule.preset === 'hourly') {
      return { kind: 'hourly', minute: rrule.minute }
    }
    if (rrule.preset === 'weekly') {
      return {
        kind: 'weekly',
        hour: rrule.hour,
        minute: rrule.minute,
        dayOfWeek: rrule.dayOfWeek
      }
    }
    if (rrule.preset === 'weekdays') {
      return { kind: 'weekdays', hour: rrule.hour, minute: rrule.minute }
    }
    return { kind: 'daily', hour: rrule.hour, minute: rrule.minute }
  } catch {
    return { kind: 'invalid' }
  }
}
