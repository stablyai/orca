import type { AutomationSchedulePreset } from '../automation-definition'
import { cronHasPossibleOccurrence } from './automation-cron-occurrence'
import { readRruleInterval } from './automation-rrule-interval'
import {
  formatScheduleRefusal,
  type AutomationScheduleRefusalHints
} from './automation-schedule-refusal'

import { isClipboardTextByteLengthOverLimit } from '../../clipboard/clipboard-text'
import {
  DAY_NAMES,
  MONTH_NAMES,
  isCronFieldRestricted,
  parseCronField,
  type CronParseOptions
} from './automation-cron-field-parsing'

export const AUTOMATION_CRON_EXPRESSION_MAX_BYTES = 2 * 1024
export type ParsedRrule = {
  kind: 'rrule'
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY'
  /** Runs every Nth hour, day or week, counted from dtstart. */
  interval: number
  byDay: string[]
  byHour: number
  byMinute: number
  /** First part the scheduler drops; stored rules still run without it. */
  ignoredPart: string | null
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
  /** No `*` term in minute or hour: each time names one wall-clock moment, so DST must not skip or repeat it. */
  fixedTime: boolean
}

export type ParsedSchedule = ParsedRrule | ParsedCron
export type { CronParseOptions }

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR'] as const
const RRULE_PARTS_BY_FREQ = {
  HOURLY: ['FREQ', 'INTERVAL', 'BYMINUTE'],
  DAILY: ['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE'],
  WEEKLY: ['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE']
} as const
// Parts that match what the scheduler already does, so dropping them changes nothing.
const NO_OP_RRULE_PARTS = new Set(['BYSECOND=0', ...DAY_CODES.map((day) => `WKST=${day}`)])

function parseRrule(rrule: string): ParsedRrule {
  const entries = new Map<string, string>()
  let ignoredPart: string | null = null
  for (const part of rrule.split(';')) {
    if (!part) {
      continue
    }
    const [key, value, extra] = part.split('=')
    const upperKey = key?.toUpperCase()
    if (!upperKey || !value || extra !== undefined) {
      ignoredPart ??= part
    }
    if (upperKey && value) {
      // A repeated key overwrites the earlier one, so the earlier part is the one dropped.
      const earlier = entries.get(upperKey)
      if (earlier !== undefined) {
        ignoredPart ??= `${upperKey}=${earlier}`
      }
      entries.set(upperKey, value)
    }
  }
  const freq = entries.get('FREQ')
  if (freq !== 'HOURLY' && freq !== 'DAILY' && freq !== 'WEEKLY') {
    throw new Error('Unsupported automation recurrence.')
  }
  if (ignoredPart === null) {
    const supported: readonly string[] = RRULE_PARTS_BY_FREQ[freq]
    for (const [key, value] of entries) {
      if (!supported.includes(key) && !NO_OP_RRULE_PARTS.has(`${key}=${value}`)) {
        ignoredPart = `${key}=${value}`
        break
      }
    }
  }
  const { interval, ignoredPart: intervalPart } = readRruleInterval(freq, entries)
  ignoredPart ??= intervalPart
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
  return { kind: 'rrule', freq, interval, byDay, byHour, byMinute, ignoredPart }
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
    daysOfMonth: parseCronField({
      value: dayOfMonth,
      min: 1,
      max: 31,
      field: 'day of month',
      rejectOversizedStep
    }),
    months: parseCronField({
      value: month,
      min: 1,
      max: 12,
      field: 'month',
      names: MONTH_NAMES,
      rejectOversizedStep
    }),
    daysOfWeek: parseCronField({
      value: dayOfWeek,
      min: 0,
      max: 7,
      field: 'day of week',
      names: DAY_NAMES,
      normalize: (value) => (value === 7 ? 0 : value),
      distinctValueCount: 7,
      rejectOversizedStep
    }),
    dayOfMonthRestricted: isCronFieldRestricted(dayOfMonth),
    dayOfWeekRestricted: isCronFieldRestricted(dayOfWeek),
    fixedTime: isCronFieldRestricted(minute) && isCronFieldRestricted(hour)
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

/** Why new input is refused, naming what is accepted; null when accepted. */
export function getAutomationScheduleInputError(
  schedule: string,
  label = 'Invalid automation trigger.',
  hints: AutomationScheduleRefusalHints = {}
): string | null {
  let ignoredPart: string | null = null
  try {
    const parsed = parseSchedule(schedule, { rejectOversizedStep: true })
    if (
      parsed.kind === 'cron'
        ? cronHasPossibleOccurrence(parsed, Date.now())
        : parsed.ignoredPart === null
    ) {
      return null
    }
    ignoredPart = parsed.kind === 'rrule' ? parsed.ignoredPart : null
  } catch {
    // Unparseable input gets the same refusal, without a named part.
  }
  return formatScheduleRefusal(schedule, label, ignoredPart, hints)
}

/** Accepts a schedule as new input, oversized-step (#15895) and ignored-part (#45519) refusals included. */
export function isValidAutomationSchedule(schedule: string): boolean {
  return getAutomationScheduleInputError(schedule) === null
}

/** Rebuilds a stored RRULE from the cadence that runs, so new-input checks accept it. */
export function withoutIgnoredRruleParts(schedule: string): string {
  try {
    const rule = parseSchedule(schedule)
    if (rule.kind === 'cron' || rule.ignoredPart === null) {
      return schedule
    }
    return [
      `FREQ=${rule.freq}`,
      ...(rule.interval > 1 ? [`INTERVAL=${rule.interval}`] : []),
      ...(rule.freq === 'WEEKLY' ? [`BYDAY=${rule.byDay.join(',')}`] : []),
      ...(rule.freq === 'HOURLY' ? [] : [`BYHOUR=${rule.byHour}`]),
      `BYMINUTE=${rule.byMinute}`
    ].join(';')
  } catch {
    return schedule
  }
}

export function isValidAutomationCronSchedule(schedule: string): boolean {
  return cronScheduleRuns(schedule, { rejectOversizedStep: true })
}

// Read saved/provider-owned schedules under legacy cadence, not new-input step gates, so renames cannot force schedule re-authoring.
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
  // An interval rule has no preset; describing it as one would hide that it skips periods.
  if (rule.interval > 1) {
    throw new Error('No preset for this recurrence.')
  }
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
  return { preset: 'weekly', hour: rule.byHour, minute: rule.byMinute, dayOfWeek }
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
