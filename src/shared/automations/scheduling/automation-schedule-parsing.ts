import type { AutomationSchedulePreset } from '../automation-definition'
import { cronHasPossibleOccurrence } from './automation-cron-occurrence'

import { isClipboardTextByteLengthOverLimit } from '../../clipboard/clipboard-text'
import { escapeTerminalControlCharacters } from '../../terminal/output/terminal-control-character-escape'
import {
  DAY_NAMES,
  MONTH_NAMES,
  isCronDayFieldRestricted,
  parseCronField,
  type CronParseOptions
} from './automation-cron-field-parsing'

export const AUTOMATION_CRON_EXPRESSION_MAX_BYTES = 2 * 1024
export type ParsedRrule = {
  kind: 'rrule'
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY'
  interval: number
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

// Parts each FREQ can actually run; anything else is refused rather than silently ignored.
const RRULE_PARTS: Record<ParsedRrule['freq'], readonly string[]> = {
  HOURLY: ['FREQ', 'INTERVAL', 'BYMINUTE'],
  DAILY: ['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE'],
  WEEKLY: ['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE']
}

function parseRruleInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  message: string
): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new Error(message)
  }
  return parsed
}

function parseRrule(rrule: string): ParsedRrule {
  const parts = rrule.split(';')
  if (parts.at(-1) === '') {
    parts.pop()
  }
  const entries = parts.map((part) => {
    const separator = part.indexOf('=')
    return separator === -1
      ? { key: part.toUpperCase(), value: undefined }
      : { key: part.slice(0, separator).toUpperCase(), value: part.slice(separator + 1) }
  })
  const freq = entries.find((entry) => entry.key === 'FREQ')?.value
  if (freq !== 'HOURLY' && freq !== 'DAILY' && freq !== 'WEEKLY') {
    throw new Error('Unsupported automation recurrence.')
  }
  const values = new Map<string, string>()
  for (const { key, value } of entries) {
    if (value === undefined || values.has(key) || !RRULE_PARTS[freq].includes(key)) {
      // Schedules can come from synced hosts, and this message is printed by the CLI and editor.
      const shownKey = escapeTerminalControlCharacters(key, true)
      throw new Error(`Unsupported RRULE part "${shownKey}" for FREQ=${freq}.`)
    }
    values.set(key, value)
  }
  const interval = parseRruleInteger(
    values.get('INTERVAL'),
    1,
    1,
    52,
    'Invalid recurrence interval.'
  )
  const byHour = parseRruleInteger(values.get('BYHOUR'), 9, 0, 23, 'Invalid recurrence hour.')
  const byMinute = parseRruleInteger(values.get('BYMINUTE'), 0, 0, 59, 'Invalid recurrence minute.')
  const byDay = (values.get('BYDAY') ?? '').split(',').filter(Boolean)
  if (
    freq === 'WEEKLY' &&
    (byDay.length === 0 ||
      byDay.some((day) => !DAY_CODES.includes(day as (typeof DAY_CODES)[number])))
  ) {
    throw new Error('Invalid recurrence day.')
  }
  return { kind: 'rrule', freq, interval, byDay, byHour, byMinute }
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
    dayOfMonthRestricted: isCronDayFieldRestricted(dayOfMonth),
    dayOfWeekRestricted: isCronDayFieldRestricted(dayOfWeek)
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

export function automationScheduleParseError(schedule: string): string | null {
  try {
    parseSchedule(schedule)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** True when only a scheduler with the newer rule support can run this schedule. */
export function needsScheduleRulesCapability(schedule: string): boolean {
  try {
    const parsed = parseSchedule(schedule)
    return parsed.kind === 'rrule' && parsed.interval > 1
  } catch {
    return false
  }
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
