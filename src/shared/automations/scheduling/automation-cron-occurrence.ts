import type { ParsedCron } from './automation-schedule-parsing'
import { LOCAL_SCHEDULE_CALENDAR, type ScheduleCalendar } from './automation-schedule-calendar'

const CRON_SCAN_DAYS = 9 * 366

export function startOfLocalDay(timestamp: number): number {
  return LOCAL_SCHEDULE_CALENDAR.startOfDay(timestamp)
}

export function addLocalDays(day: number, days: number): number {
  return LOCAL_SCHEDULE_CALENDAR.addDays(day, days)
}

// Why: local-field recomposition resolves a repeated fall-back minute to the earlier offset.
export function floorToMinute(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000
}

export function cronMatches(
  rule: ParsedCron,
  timestamp: number,
  calendar: ScheduleCalendar = LOCAL_SCHEDULE_CALENDAR
): boolean {
  const wall = calendar.fields(timestamp)
  return (
    cronWallDateMatches(rule, wall) && rule.hours.has(wall.hour) && rule.minutes.has(wall.minute)
  )
}

export function cronDateMatches(
  rule: ParsedCron,
  timestamp: number,
  calendar: ScheduleCalendar = LOCAL_SCHEDULE_CALENDAR
): boolean {
  return cronWallDateMatches(rule, calendar.fields(timestamp))
}

function cronWallDateMatches(
  rule: ParsedCron,
  wall: { month: number; day: number; weekday: number }
): boolean {
  if (!rule.months.has(wall.month)) {
    return false
  }
  const dayOfMonthMatches = rule.daysOfMonth.has(wall.day)
  const dayOfWeekMatches = rule.daysOfWeek.has(wall.weekday)
  // Dialect rule; the flags are lexical (`isCronDayFieldRestricted`), not set sizes.
  if (rule.dayOfMonthRestricted && rule.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches
  }
  return dayOfMonthMatches && dayOfWeekMatches
}

export function cronHasPossibleOccurrence(rule: ParsedCron, anchor: number): boolean {
  let day = startOfLocalDay(anchor)
  for (let i = 0; i < CRON_SCAN_DAYS; i += 1) {
    if (cronDateMatches(rule, day)) {
      return true
    }
    day = addLocalDays(day, 1)
  }
  return false
}
