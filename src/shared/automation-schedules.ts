/* eslint-disable max-lines -- Why: automation scheduling needs RRULE presets and
 * custom cron parsing to share one execution path for main/renderer parity. */
import type { AutomationSchedulePreset } from './automations-types'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const CRON_SCAN_MINUTES = 370 * 24 * 60

type ParsedRrule = {
  kind: 'rrule'
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY'
  byDay: string[]
  byHour: number
  byMinute: number
}

type ParsedCron = {
  kind: 'cron'
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

type ParsedSchedule = ParsedRrule | ParsedCron

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR'] as const
const MONTH_NAMES = new Map([
  ['JAN', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['APR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AUG', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DEC', 12]
])
const DAY_NAMES = new Map<string, number>([
  ...DAY_CODES.map((code, index) => [code, index] as const),
  ['SUN', 0],
  ['MON', 1],
  ['TUE', 2],
  ['WED', 3],
  ['THU', 4],
  ['FRI', 5],
  ['SAT', 6]
])

function parseRrule(rrule: string): ParsedRrule {
  const entries = new Map<string, string>()
  for (const part of rrule.split(';')) {
    const [key, value] = part.split('=')
    if (key && value) {
      entries.set(key.toUpperCase(), value)
    }
  }
  const freq = entries.get('FREQ')
  if (freq !== 'HOURLY' && freq !== 'DAILY' && freq !== 'WEEKLY') {
    throw new Error('Unsupported automation recurrence.')
  }
  const byHour = Number(entries.get('BYHOUR') ?? '9')
  const byMinute = Number(entries.get('BYMINUTE') ?? '0')
  if (!Number.isInteger(byHour) || byHour < 0 || byHour > 23) {
    throw new Error('Invalid recurrence hour.')
  }
  if (!Number.isInteger(byMinute) || byMinute < 0 || byMinute > 59) {
    throw new Error('Invalid recurrence minute.')
  }
  const byDay = (entries.get('BYDAY') ?? '').split(',').filter(Boolean)
  return { kind: 'rrule', freq, byDay, byHour, byMinute }
}

function parseCronNumber(value: string, names: Map<string, number> | null, field: string): number {
  const normalized = value.toUpperCase()
  const named = names?.get(normalized)
  const parsed = named ?? Number(normalized)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron ${field}.`)
  }
  return parsed
}

function parseCronField(args: {
  value: string
  min: number
  max: number
  field: string
  names?: Map<string, number>
  normalize?: (value: number) => number
}): Set<number> {
  const result = new Set<number>()
  for (const rawPart of args.value.split(',')) {
    const part = rawPart.trim()
    if (!part) {
      throw new Error(`Invalid cron ${args.field}.`)
    }
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron ${args.field}.`)
    }

    let start: number
    let end: number
    if (rangePart === '*') {
      start = args.min
      end = args.max
    } else if (rangePart.includes('-')) {
      const [startPart, endPart] = rangePart.split('-')
      start = parseCronNumber(startPart, args.names ?? null, args.field)
      end = parseCronNumber(endPart, args.names ?? null, args.field)
    } else {
      start = parseCronNumber(rangePart, args.names ?? null, args.field)
      end = start
    }

    const normalizedStart = args.normalize?.(start) ?? start
    const normalizedEnd = args.normalize?.(end) ?? end
    if (
      normalizedStart < args.min ||
      normalizedStart > args.max ||
      normalizedEnd < args.min ||
      normalizedEnd > args.max ||
      normalizedStart > normalizedEnd
    ) {
      throw new Error(`Invalid cron ${args.field}.`)
    }
    for (let value = normalizedStart; value <= normalizedEnd; value += step) {
      result.add(value)
    }
  }
  if (result.size === 0) {
    throw new Error(`Invalid cron ${args.field}.`)
  }
  return result
}

function parseCronExpression(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error('Cron schedule must have five fields.')
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  return {
    kind: 'cron',
    minutes: parseCronField({ value: minute, min: 0, max: 59, field: 'minute' }),
    hours: parseCronField({ value: hour, min: 0, max: 23, field: 'hour' }),
    daysOfMonth: parseCronField({ value: dayOfMonth, min: 1, max: 31, field: 'day of month' }),
    months: parseCronField({ value: month, min: 1, max: 12, field: 'month', names: MONTH_NAMES }),
    daysOfWeek: parseCronField({
      value: dayOfWeek,
      min: 0,
      max: 6,
      field: 'day of week',
      names: DAY_NAMES,
      normalize: (value) => (value === 7 ? 0 : value)
    }),
    dayOfMonthRestricted: dayOfMonth !== '*',
    dayOfWeekRestricted: dayOfWeek !== '*'
  }
}

function parseSchedule(schedule: string): ParsedSchedule {
  const trimmed = schedule.trim()
  if (trimmed.includes('=')) {
    return parseRrule(trimmed)
  }
  return parseCronExpression(trimmed)
}

export function isValidAutomationSchedule(schedule: string): boolean {
  try {
    parseSchedule(schedule)
    return true
  } catch {
    return false
  }
}

export function parseAutomationRrule(rrule: string): {
  preset: AutomationSchedulePreset
  hour: number
  minute: number
  dayOfWeek: number
} {
  const rule = parseRrule(rrule)
  if (rule.freq === 'HOURLY') {
    return { preset: 'hourly', hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 }
  }
  if (rule.freq === 'DAILY') {
    return { preset: 'daily', hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 }
  }
  if (rule.byDay.join(',') === WEEKDAY_CODES.join(',')) {
    return { preset: 'weekdays', hour: rule.byHour, minute: rule.byMinute, dayOfWeek: 1 }
  }
  if (rule.byDay.length !== 1) {
    throw new Error('Invalid recurrence day.')
  }
  const dayCode = rule.byDay[0]
  const dayOfWeek = DAY_CODES.indexOf(dayCode as (typeof DAY_CODES)[number])
  if (dayOfWeek < 0) {
    throw new Error('Invalid recurrence day.')
  }
  return {
    preset: 'weekly',
    hour: rule.byHour,
    minute: rule.byMinute,
    dayOfWeek
  }
}

export function tryParseAutomationRrule(
  rrule: string
): ReturnType<typeof parseAutomationRrule> | null {
  try {
    return parseAutomationRrule(rrule)
  } catch {
    return null
  }
}

function formatTime(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

export function formatAutomationSchedule(rrule: string): string {
  const schedule = tryParseAutomationRrule(rrule)
  if (!schedule) {
    return isValidAutomationSchedule(rrule) ? `Custom cron: ${rrule.trim()}` : 'Invalid schedule'
  }
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
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(
    new Date(2026, 0, 4 + schedule.dayOfWeek)
  )
  return `${day}s at ${time}`
}

function atLocalTime(dayMs: number, hour: number, minute: number): number {
  const date = new Date(dayMs)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
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

function floorToMinute(timestamp: number): number {
  const date = new Date(timestamp)
  date.setSeconds(0, 0)
  return date.getTime()
}

function cronMatches(rule: ParsedCron, timestamp: number): boolean {
  const date = new Date(timestamp)
  if (!rule.months.has(date.getMonth() + 1)) {
    return false
  }
  if (!rule.hours.has(date.getHours()) || !rule.minutes.has(date.getMinutes())) {
    return false
  }
  const dayOfMonthMatches = rule.daysOfMonth.has(date.getDate())
  const dayOfWeekMatches = rule.daysOfWeek.has(date.getDay())
  if (rule.dayOfMonthRestricted && rule.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches
  }
  return dayOfMonthMatches && dayOfWeekMatches
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
    if (candidate <= after) {
      candidate += HOUR_MS
    }
    return Math.max(candidate, dtstart)
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
