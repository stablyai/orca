import type { AutomationSchedulePreset } from '../automation-definition'
import {
  parseSchedule,
  type ParsedCron,
  type ParsedRrule,
  type ParsedSchedule
} from './automation-schedule-parsing'
import { cronDateMatches, cronMatches, floorToMinute } from './automation-cron-occurrence'
import { automationScheduleCalendar, type ScheduleCalendar } from './automation-schedule-calendar'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
// Why: valid cron expressions like Feb 29 can have an 8-year gap across non-leap centuries.
const CRON_SCAN_DAYS = 9 * 366
const CRON_SCAN_MINUTES = CRON_SCAN_DAYS * 24 * 60
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

function dayMatches(rule: ParsedRrule, calendar: ScheduleCalendar, timestamp: number): boolean {
  if (rule.freq === 'DAILY') {
    return true
  }
  const code = DAY_CODES[calendar.fields(timestamp).weekday]
  return rule.byDay.includes(code)
}

/** The nearest time after `anchor` (direction 1) or at or before it (-1) that `timesOn` names. */
function scanDayCandidates(
  calendar: ScheduleCalendar,
  anchor: number,
  direction: 1 | -1,
  days: number,
  timesOn: (day: number) => number[]
): number | null {
  let day = calendar.startOfDay(anchor)
  for (let i = 0; i < days; i += 1) {
    let nearest: number | null = null
    for (const candidate of timesOn(day)) {
      const inRange = direction === 1 ? candidate > anchor : candidate <= anchor
      if (inRange && (nearest === null || (candidate - nearest) * direction < 0)) {
        nearest = candidate
      }
    }
    if (nearest !== null) {
      return nearest
    }
    day = calendar.addDays(day, direction)
  }
  return null
}

function rruleTimesOn(rule: ParsedRrule, calendar: ScheduleCalendar, day: number): number[] {
  const candidate = calendar.atTime(day, rule.byHour, rule.byMinute)
  return dayMatches(rule, calendar, candidate) ? [candidate] : []
}

// Why: a fixed time resolves as an RRULE time does (RFC 5545): a fall-back repeat fires once, on
// its first pass, and a time spring-forward skips fires the gap's length later.
function fixedCronTimesOn(rule: ParsedCron, calendar: ScheduleCalendar, day: number): number[] {
  if (!cronDateMatches(rule, day, calendar)) {
    return []
  }
  const times: number[] = []
  for (const hour of rule.hours) {
    for (const minute of rule.minutes) {
      times.push(calendar.atTime(day, hour, minute))
    }
  }
  return times
}

function timesOnDay(rule: ParsedSchedule, calendar: ScheduleCalendar): (day: number) => number[] {
  return rule.kind === 'cron'
    ? (day) => fixedCronTimesOn(rule, calendar, day)
    : (day) => rruleTimesOn(rule, calendar, day)
}

function hourlyMatches(rule: ParsedRrule, calendar: ScheduleCalendar, timestamp: number): boolean {
  return calendar.fields(timestamp).minute === rule.byMinute
}

// Why: walk absolute minutes; recomposing local fields can't address the second pass of a fall-back hour.
function nextMatchingMinute(
  dtstart: number,
  after: number,
  matches: (timestamp: number) => boolean
): number {
  let candidate = floorToMinute(Math.max(dtstart, after))
  if (candidate <= after || candidate < dtstart) {
    candidate += MINUTE_MS
  }
  for (let i = 0; i < CRON_SCAN_MINUTES; i += 1) {
    if (matches(candidate)) {
      return candidate
    }
    candidate += MINUTE_MS
  }
  throw new Error('Unable to compute next automation run.')
}

function latestMatchingMinute(
  dtstart: number,
  now: number,
  matches: (timestamp: number) => boolean
): number | null {
  let candidate = floorToMinute(now)
  for (let i = 0; i < CRON_SCAN_MINUTES && candidate >= dtstart; i += 1) {
    if (matches(candidate)) {
      return candidate
    }
    candidate -= MINUTE_MS
  }
  return null
}

export function buildAutomationRrule(args: {
  preset: Exclude<AutomationSchedulePreset, 'custom'>
  hour: number
  minute: number
  dayOfWeek?: number
}): string {
  const hour = Math.max(0, Math.min(23, Math.floor(args.hour)))
  const minute = Math.max(0, Math.min(59, Math.floor(args.minute)))
  if (args.preset === 'hourly') {
    return `FREQ=HOURLY;BYMINUTE=${minute}`
  }
  if (args.preset === 'weekdays') {
    return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${hour};BYMINUTE=${minute}`
  }
  if (args.preset === 'weekly') {
    const day = DAY_CODES[Math.max(0, Math.min(6, Math.floor(args.dayOfWeek ?? 1)))]
    return `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${hour};BYMINUTE=${minute}`
  }
  return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`
}

export function buildAutomationCronSchedule(args: {
  preset: Exclude<AutomationSchedulePreset, 'custom'>
  hour: number
  minute: number
  dayOfWeek?: number
}): string {
  const hour = Math.max(0, Math.min(23, Math.floor(args.hour)))
  const minute = Math.max(0, Math.min(59, Math.floor(args.minute)))
  if (args.preset === 'hourly') {
    return `${minute} * * * *`
  }
  if (args.preset === 'weekdays') {
    return `${minute} ${hour} * * 1-5`
  }
  if (args.preset === 'weekly') {
    const day = Math.max(0, Math.min(6, Math.floor(args.dayOfWeek ?? 1)))
    return `${minute} ${hour} * * ${day}`
  }
  return `${minute} ${hour} * * *`
}

/** `timezone` is the automation's; its hours and days are read on that wall clock. */
export function nextAutomationOccurrenceAfter(
  rrule: string,
  dtstart: number,
  after: number,
  timezone?: string
): number {
  const rule = parseSchedule(rrule)
  const calendar = automationScheduleCalendar(timezone)
  if (rule.kind === 'cron' && !rule.fixedTime) {
    return nextMatchingMinute(dtstart, after, (candidate) => cronMatches(rule, candidate, calendar))
  }
  if (rule.kind === 'rrule' && rule.freq === 'HOURLY') {
    return nextMatchingMinute(dtstart, after, (candidate) =>
      hourlyMatches(rule, calendar, candidate)
    )
  }
  const candidate = scanDayCandidates(
    calendar,
    Math.max(dtstart - 1, after),
    1,
    CRON_SCAN_DAYS,
    timesOnDay(rule, calendar)
  )
  if (candidate === null) {
    throw new Error('Unable to compute next automation run.')
  }
  return candidate
}

export function latestAutomationOccurrenceAtOrBefore(
  rrule: string,
  dtstart: number,
  now: number,
  timezone?: string
): number | null {
  if (now < dtstart) {
    return null
  }
  const rule = parseSchedule(rrule)
  const calendar = automationScheduleCalendar(timezone)
  if (rule.kind === 'cron' && !rule.fixedTime) {
    return latestMatchingMinute(dtstart, now, (candidate) => cronMatches(rule, candidate, calendar))
  }
  if (rule.kind === 'rrule' && rule.freq === 'HOURLY') {
    return latestMatchingMinute(dtstart, now, (candidate) =>
      hourlyMatches(rule, calendar, candidate)
    )
  }
  // Back to dtstart and no further; the two spare days cover partial ends and short DST days.
  const days = Math.min(CRON_SCAN_DAYS, Math.ceil((now - dtstart) / DAY_MS) + 2)
  const candidate = scanDayCandidates(calendar, now, -1, days, timesOnDay(rule, calendar))
  return candidate !== null && candidate >= dtstart ? candidate : null
}
