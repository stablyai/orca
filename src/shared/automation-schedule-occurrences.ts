import type { AutomationSchedulePreset } from './automations-types'
import { parseSchedule, type ParsedRrule } from './automation-schedule-parsing'
import { cronMatches, floorToMinute, startOfLocalDay } from './automation-cron-occurrence'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
// Why: valid cron expressions like Feb 29 can have an 8-year gap across non-leap centuries.
const CRON_SCAN_DAYS = 9 * 366
const CRON_SCAN_MINUTES = CRON_SCAN_DAYS * 24 * 60
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
function atLocalTime(dayMs: number, hour: number, minute: number): number {
  const date = new Date(dayMs)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

function dayMatches(rule: ParsedRrule, timestamp: number): boolean {
  if (rule.freq === 'DAILY') {
    return true
  }
  const code = DAY_CODES[new Date(timestamp).getDay()]
  return rule.byDay.includes(code)
}

function scanDayCandidates(rule: ParsedRrule, anchor: number, direction: 1 | -1): number | null {
  let day = startOfLocalDay(anchor)
  for (let i = 0; i < 370; i += 1) {
    const candidate = atLocalTime(day, rule.byHour, rule.byMinute)
    if (dayMatches(rule, candidate)) {
      if (direction === 1 && candidate > anchor) {
        return candidate
      }
      if (direction === -1 && candidate <= anchor) {
        return candidate
      }
    }
    day += direction * DAY_MS
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

export function nextAutomationOccurrenceAfter(
  rrule: string,
  dtstart: number,
  after: number
): number {
  const rule = parseSchedule(rrule)
  if (rule.kind === 'cron') {
    let candidate = floorToMinute(Math.max(dtstart, after))
    if (candidate <= after) {
      candidate += MINUTE_MS
    }
    if (candidate < dtstart) {
      candidate = floorToMinute(dtstart)
      if (candidate < dtstart) {
        candidate += MINUTE_MS
      }
    }
    for (let i = 0; i < CRON_SCAN_MINUTES; i += 1) {
      if (cronMatches(rule, candidate)) {
        return candidate
      }
      candidate += MINUTE_MS
    }
    throw new Error('Unable to compute next automation run.')
  }
  if (rule.freq === 'HOURLY') {
    const start = Math.max(dtstart, after)
    const base = new Date(start)
    base.setMinutes(rule.byMinute, 0, 0)
    let candidate = base.getTime()
    if (candidate <= after || candidate < dtstart) {
      candidate += HOUR_MS
    }
    return candidate
  }
  const candidate = scanDayCandidates(rule, Math.max(dtstart - 1, after), 1)
  if (candidate === null) {
    throw new Error('Unable to compute next automation run.')
  }
  return candidate
}

export function latestAutomationOccurrenceAtOrBefore(
  rrule: string,
  dtstart: number,
  now: number
): number | null {
  if (now < dtstart) {
    return null
  }
  const rule = parseSchedule(rrule)
  if (rule.kind === 'cron') {
    let candidate = floorToMinute(now)
    for (let i = 0; i < CRON_SCAN_MINUTES && candidate >= dtstart; i += 1) {
      if (cronMatches(rule, candidate)) {
        return candidate
      }
      candidate -= MINUTE_MS
    }
    return null
  }
  if (rule.freq === 'HOURLY') {
    const base = new Date(now)
    base.setMinutes(rule.byMinute, 0, 0)
    let candidate = base.getTime()
    if (candidate > now) {
      candidate -= HOUR_MS
    }
    return candidate >= dtstart ? candidate : null
  }
  const candidate = scanDayCandidates(rule, now, -1)
  return candidate !== null && candidate >= dtstart ? candidate : null
}
