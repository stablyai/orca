import type { AutomationSchedulePreset } from './automations-types'
import { cronHasPossibleOccurrence } from './automation-cron-occurrence'

import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

export const AUTOMATION_CRON_EXPRESSION_MAX_BYTES = 2 * 1024
export type ParsedRrule = {
  kind: 'rrule'
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY'
  byDay: string[]
  byHour: number
  byMinute: number
}

export type ParsedCron = {
  kind: 'cron'
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

export type ParsedSchedule = ParsedRrule | ParsedCron
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR'] as const
const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12
}
const DAY_NAMES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6
}

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
  if (
    freq === 'WEEKLY' &&
    (byDay.length === 0 ||
      byDay.some((day) => !DAY_CODES.includes(day as (typeof DAY_CODES)[number])))
  ) {
    throw new Error('Invalid recurrence day.')
  }
  return { kind: 'rrule', freq, byDay, byHour, byMinute }
}

function parseCronNumber(
  value: string,
  names: Record<string, number> | null,
  field: string
): number {
  const normalized = value.toUpperCase()
  const named = names?.[normalized]
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
  names?: Record<string, number>
  normalize?: (value: number) => number
}): Set<number> {
  const result = new Set<number>()
  for (const rawPart of args.value.split(',')) {
    const part = rawPart.trim()
    if (!part) {
      throw new Error(`Invalid cron ${args.field}.`)
    }
    const stepParts = part.split('/')
    if (stepParts.length > 2) {
      throw new Error(`Invalid cron ${args.field}.`)
    }
    const [rangePart, stepPart] = stepParts
    if (!rangePart) {
      throw new Error(`Invalid cron ${args.field}.`)
    }
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
      const rangeParts = rangePart.split('-')
      if (rangeParts.length !== 2 || !rangeParts[0] || !rangeParts[1]) {
        throw new Error(`Invalid cron ${args.field}.`)
      }
      const [startPart, endPart] = rangeParts
      start = parseCronNumber(startPart, args.names ?? null, args.field)
      end = parseCronNumber(endPart, args.names ?? null, args.field)
    } else {
      start = parseCronNumber(rangePart, args.names ?? null, args.field)
      end = start
    }

    const normalizedStart = args.normalize?.(start) ?? start
    const normalizedEnd = args.normalize?.(end) ?? end
    if (
      start < args.min ||
      start > args.max ||
      end < args.min ||
      end > args.max ||
      normalizedStart < args.min ||
      normalizedStart > args.max ||
      normalizedEnd < args.min ||
      normalizedEnd > args.max ||
      start > end
    ) {
      throw new Error(`Invalid cron ${args.field}.`)
    }
    for (let value = start; value <= end; value += step) {
      result.add(args.normalize?.(value) ?? value)
    }
  }
  if (result.size === 0) {
    throw new Error(`Invalid cron ${args.field}.`)
  }
  return result
}

export function parseCronExpression(expression: string): ParsedCron {
  const parts = getAutomationCronExpressionFields(expression, 6)
  if (parts.length !== 5) {
    throw new Error('Cron schedule must have five fields.')
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  const daysOfMonth = parseCronField({
    value: dayOfMonth,
    min: 1,
    max: 31,
    field: 'day of month'
  })
  const daysOfWeek = parseCronField({
    value: dayOfWeek,
    min: 0,
    max: 7,
    field: 'day of week',
    names: DAY_NAMES,
    normalize: (value) => (value === 7 ? 0 : value)
  })
  return {
    kind: 'cron',
    minutes: parseCronField({ value: minute, min: 0, max: 59, field: 'minute' }),
    hours: parseCronField({ value: hour, min: 0, max: 23, field: 'hour' }),
    daysOfMonth,
    months: parseCronField({ value: month, min: 1, max: 12, field: 'month', names: MONTH_NAMES }),
    daysOfWeek,
    dayOfMonthRestricted: daysOfMonth.size !== 31,
    dayOfWeekRestricted: daysOfWeek.size !== 7
  }
}

export function getAutomationCronExpressionFields(expression: string, maxFields = 5): string[] {
  if (isClipboardTextByteLengthOverLimit(expression, AUTOMATION_CRON_EXPRESSION_MAX_BYTES)) {
    return []
  }
  const fields: string[] = []
  let tokenStart = -1
  for (let index = 0; index <= expression.length; index += 1) {
    const isEnd = index === expression.length
    if (!isEnd && !isAutomationCronFieldWhitespace(expression.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      fields.push(expression.slice(tokenStart, index))
      tokenStart = -1
      if (fields.length >= maxFields) {
        break
      }
    }
  }
  return fields
}

function isAutomationCronFieldWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

export function parseSchedule(schedule: string): ParsedSchedule {
  const trimmed = schedule.trim()
  if (trimmed.includes('=')) {
    return parseRrule(trimmed)
  }
  return parseCronExpression(trimmed)
}

export function isValidAutomationSchedule(schedule: string): boolean {
  try {
    const parsed = parseSchedule(schedule)
    if (parsed.kind === 'cron' && !cronHasPossibleOccurrence(parsed, Date.now())) {
      throw new Error('Cron schedule has no possible run.')
    }
    return true
  } catch {
    return false
  }
}

export function isValidAutomationCronSchedule(schedule: string): boolean {
  try {
    const parsed = parseCronExpression(schedule.trim())
    return cronHasPossibleOccurrence(parsed, Date.now())
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
  if (dayOfWeek === -1) {
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
