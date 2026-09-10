import type { ParsedSchedule } from './automation-schedule-parsing'
import { cronCalendarDateMatches } from './automation-cron-occurrence'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

function timezoneFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
}

export function isValidAutomationTimezone(timezone: string): boolean {
  try {
    timezoneFormatter(timezone)
    return true
  } catch {
    return false
  }
}

// UTC getters on this value describe the scheduled wall clock, never the host's timezone.
function wallTime(formatter: Intl.DateTimeFormat, timestamp: number): number {
  const fields: Record<string, number> = {}
  for (const part of formatter.formatToParts(timestamp)) {
    if (part.type !== 'literal') {
      fields[part.type] = Number(part.value)
    }
  }
  return Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second
  )
}

function matchesDay(rule: ParsedSchedule, day: Date): boolean {
  if (rule.kind === 'cron') {
    return cronCalendarDateMatches(rule, day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay())
  }
  return rule.freq !== 'WEEKLY' || rule.byDay.includes(DAY_CODES[day.getUTCDay()])
}

function dayOccurrences(
  rule: ParsedSchedule,
  day: number,
  formatter: Intl.DateTimeFormat
): number[] {
  const hours =
    rule.kind === 'cron'
      ? [...rule.hours]
      : rule.freq === 'HOURLY'
        ? Array.from({ length: 24 }, (_, hour) => hour)
        : [rule.byHour]
  const minutes = rule.kind === 'cron' ? [...rule.minutes] : [rule.byMinute]
  const offsets = new Set<number>()
  // Adjacent UTC days cover both sides of a timezone transition, including a skipped local day.
  for (const delta of [-1, 0, 1, 2]) {
    const sample = day + delta * DAY_MS
    offsets.add(wallTime(formatter, sample) - sample)
  }
  const candidates: number[] = []
  for (const hour of hours) {
    for (const minute of minutes) {
      const wall = day + (hour * 60 + minute) * MINUTE_MS
      for (const offset of offsets) {
        const candidate = wall - offset
        // A missing local time has no match; a repeated time has two distinct matching instants.
        if (wallTime(formatter, candidate) === wall) {
          candidates.push(candidate)
        }
      }
    }
  }
  return candidates.sort((left, right) => left - right)
}

export function zonedAutomationOccurrence(
  rule: ParsedSchedule,
  dtstart: number,
  anchor: number,
  direction: 1 | -1,
  timezone: string
): number | null {
  const formatter = timezoneFormatter(timezone)
  if (direction === -1 && anchor < dtstart) {
    return null
  }
  const start = direction === 1 ? Math.max(dtstart, anchor) : anchor
  const localDay = new Date(wallTime(formatter, start))
  localDay.setUTCHours(0, 0, 0, 0)
  const firstDay = new Date(wallTime(formatter, dtstart))
  firstDay.setUTCHours(0, 0, 0, 0)
  // Feb 29 can have an eight-year gap across a non-leap century.
  for (let i = 0; i < 9 * 366; i += 1) {
    if (direction === -1 && localDay.getTime() < firstDay.getTime()) {
      return null
    }
    if (matchesDay(rule, localDay)) {
      const candidates = dayOccurrences(rule, localDay.getTime(), formatter)
      if (direction === -1) {
        candidates.reverse()
      }
      for (const candidate of candidates) {
        if (candidate >= dtstart && (direction === 1 ? candidate > anchor : candidate <= anchor)) {
          return candidate
        }
      }
    }
    localDay.setUTCDate(localDay.getUTCDate() + direction)
  }
  return null
}
