import type { AutomationSchedulePreset } from './automations-types'
import { cronHasPossibleOccurrence } from './automation-cron-occurrence'

import { isClipboardTextByteLengthOverLimit } from './clipboard-text'
import {
  DAY_NAMES,
  MONTH_NAMES,
  parseCronField,
  type CronParseOptions
} from './automation-cron-field-parsing'

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
export type { CronParseOptions }

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR'] as const

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

export function parseCronExpression(
  expression: string,
  options: CronParseOptions = {}
): ParsedCron {
  const parts = getAutomationCronExpressionFields(expression, 6)
  if (parts.length !== 5) {
    throw new Error('Cron schedule must have five fields.')
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  const rejectOversizedStep = options.rejectOversizedStep ?? false
  const daysOfMonth = parseCronField({
    value: dayOfMonth,
    min: 1,
    max: 31,
    field: 'day of month',
    rejectOversizedStep
  })
  const daysOfWeek = parseCronField({
    value: dayOfWeek,
    min: 0,
    max: 7,
    field: 'day of week',
    names: DAY_NAMES,
    normalize: (value) => (value === 7 ? 0 : value),
    distinctValueCount: 7,
    rejectOversizedStep
  })
  return {
    kind: 'cron',
    minutes: parseCronField({
      value: minute,
      min: 0,
      max: 59,
      field: 'minute',
      rejectOversizedStep
    }),
    hours: parseCronField({ value: hour, min: 0, max: 23, field: 'hour', rejectOversizedStep }),
    daysOfMonth,
    months: parseCronField({
      value: month,
      min: 1,
      max: 12,
      field: 'month',
      names: MONTH_NAMES,
      rejectOversizedStep
    }),
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

export function parseSchedule(schedule: string, options: CronParseOptions = {}): ParsedSchedule {
  const trimmed = schedule.trim()
  if (trimmed.includes('=')) {
    return parseRrule(trimmed)
  }
  return parseCronExpression(trimmed, options)
}

function scheduleRuns(schedule: string, options: CronParseOptions): boolean {
  try {
    const parsed = parseSchedule(schedule, options)
    return parsed.kind !== 'cron' || cronHasPossibleOccurrence(parsed, Date.now())
  } catch {
    return false
  }
}

function cronScheduleRuns(schedule: string, options: CronParseOptions): boolean {
  try {
    return cronHasPossibleOccurrence(parseCronExpression(schedule.trim(), options), Date.now())
  } catch {
    return false
  }
}

/** Accepts a schedule as new input, oversized-step refusal included (#15895). */
export function isValidAutomationSchedule(schedule: string): boolean {
  return scheduleRuns(schedule, { rejectOversizedStep: true })
}

export function isValidAutomationCronSchedule(schedule: string): boolean {
  return cronScheduleRuns(schedule, { rejectOversizedStep: true })
}

// Whether Orca can still run a schedule it did not just receive. A row saved before the
// oversized-step gate, or one a provider owns, keeps running the cadence it has, so reading
// it back must not re-judge it as input — otherwise renaming an automation would demand
// re-authoring a schedule the user never touched.
export function isRunnableAutomationSchedule(schedule: string): boolean {
  return scheduleRuns(schedule, {})
}

export function isRunnableAutomationCronSchedule(schedule: string): boolean {
  return cronScheduleRuns(schedule, {})
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
