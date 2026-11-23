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
// Why: valid cron expressions like Feb 29 can have an 8-year gap across non-leap centuries.
const CRON_SCAN_DAYS = 9 * 366
const CRON_SCAN_MINUTES = CRON_SCAN_DAYS * 24 * 60
const RRULE_SCAN_DAYS = 370
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** Wall times on matching days; `atTime` moves a skipped time forward and runs a repeated one once. */
type DaySchedule = {
  times: (readonly [hour: number, minute: number])[]
  dayMatches: (day: number) => boolean
  scanDays: number
}

function rruleDaySchedule(rule: ParsedRrule, calendar: ScheduleCalendar): DaySchedule {
  return {
    times: [[rule.byHour, rule.byMinute]],
    dayMatches: (day) =>
      rule.freq === 'DAILY' || rule.byDay.includes(DAY_CODES[calendar.fields(day).weekday]),
    scanDays: RRULE_SCAN_DAYS
  }
}

// Why: fixed cron hours name wall times, so they follow the RRULE DST rules; an every-hour cron
// keeps walking real minutes, like FREQ=HOURLY.
function cronDaySchedule(rule: ParsedCron, calendar: ScheduleCalendar): DaySchedule | null {
  if (rule.hours.size === 24) {
    return null
  }
  const times: (readonly [number, number])[] = []
  for (const hour of rule.hours) {
    for (const minute of rule.minutes) {
      times.push([hour, minute])
    }
  }
  return {
    times,
    dayMatches: (day) => cronDateMatches(rule, day, calendar),
    scanDays: CRON_SCAN_DAYS
  }
}

function daySchedule(rule: ParsedSchedule, calendar: ScheduleCalendar): DaySchedule | null {
  if (rule.kind === 'cron') {
    return cronDaySchedule(rule, calendar)
  }
  return rule.freq === 'HOURLY' ? null : rruleDaySchedule(rule, calendar)
}

function scanDayCandidates(
  schedule: DaySchedule,
  calendar: ScheduleCalendar,
  anchor: number,
  direction: 1 | -1
): number | null {
  let day = calendar.startOfDay(anchor)
  for (let i = 0; i < schedule.scanDays; i += 1) {
    let best: number | null = null
    for (const [hour, minute] of schedule.dayMatches(day) ? schedule.times : []) {
      const candidate = calendar.atTime(day, hour, minute)
      const inRange = direction === 1 ? candidate > anchor : candidate <= anchor
      if (inRange && (best === null || (direction === 1 ? candidate < best : candidate > best))) {
        best = candidate
      }
    }
    if (best !== null) {
      return best
    }
    day = calendar.addDays(day, direction)
  }
  return null
}

function minuteMatcher(
  rule: ParsedSchedule,
  calendar: ScheduleCalendar
): (timestamp: number) => boolean {
  if (rule.kind === 'cron') {
    return (timestamp) => cronMatches(rule, timestamp, calendar)
  }
  return (timestamp) => calendar.fields(timestamp).minute === rule.byMinute
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
  const schedule = daySchedule(rule, calendar)
  if (schedule === null) {
    return nextMatchingMinute(dtstart, after, minuteMatcher(rule, calendar))
  }
  const candidate = scanDayCandidates(schedule, calendar, Math.max(dtstart - 1, after), 1)
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
  const schedule = daySchedule(rule, calendar)
  if (schedule === null) {
    return latestMatchingMinute(dtstart, now, minuteMatcher(rule, calendar))
  }
  const candidate = scanDayCandidates(schedule, calendar, now, -1)
  return candidate !== null && candidate >= dtstart ? candidate : null
}
