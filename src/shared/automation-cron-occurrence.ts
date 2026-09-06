import type { ParsedCron } from './automation-schedule-parsing'

const DAY_MS = 24 * 60 * 60 * 1000
const CRON_SCAN_DAYS = 9 * 366

export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function floorToMinute(timestamp: number): number {
  const date = new Date(timestamp)
  date.setSeconds(0, 0)
  return date.getTime()
}

export function cronMatches(rule: ParsedCron, timestamp: number): boolean {
  if (!cronDateMatches(rule, timestamp)) {
    return false
  }
  const date = new Date(timestamp)
  return rule.hours.has(date.getHours()) && rule.minutes.has(date.getMinutes())
}

export function cronDateMatches(rule: ParsedCron, timestamp: number): boolean {
  const date = new Date(timestamp)
  return cronCalendarDateMatches(rule, date.getMonth() + 1, date.getDate(), date.getDay())
}

export function cronCalendarDateMatches(
  rule: ParsedCron,
  month: number,
  dayOfMonth: number,
  dayOfWeek: number
): boolean {
  if (!rule.months.has(month)) {
    return false
  }
  const dayOfMonthMatches = rule.daysOfMonth.has(dayOfMonth)
  const dayOfWeekMatches = rule.daysOfWeek.has(dayOfWeek)
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
    day += DAY_MS
  }
  return false
}
