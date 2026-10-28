// Detect saved cron cadence changes from parser repairs #15723/#15896, including increased and decreased frequency.
import {
  getAutomationCronExpressionFields,
  parseCronExpression,
  type ParsedCron
} from './automation-schedule-parsing'
import { cronDateMatches } from './automation-cron-occurrence'

// Two years covers every day-of-month against day-of-week pairing a schedule can land on,
// which is the only part of matching that depends on the calendar rather than the sets.
const DRIFT_SCAN_DAYS = 730

export type AutomationScheduleDrift = {
  expression: string
  /** Runs a year under the cadence as it was read before the repair, and as it reads now. */
  previousRunsPerYear: number
  currentRunsPerYear: number
}

/** Pre-repair bare N/step ignored step; retain star/range step semantics. */
function toPreRepairField(field: string): string {
  return field
    .split(',')
    .map((term) => {
      const [range, step] = term.split('/')
      if (step === undefined || range.includes('*') || range.includes('-')) {
        return term
      }
      return range
    })
    .join(',')
}

/** Pre-repair day restriction used expanded-set size, so 1-31 incorrectly appeared unrestricted. */
function parsePreRepairCron(expression: string): ParsedCron {
  const fields = getAutomationCronExpressionFields(expression, 6)
  const parsed = parseCronExpression(fields.map(toPreRepairField).join(' '))
  return {
    ...parsed,
    dayOfMonthRestricted: parsed.daysOfMonth.size !== 31,
    dayOfWeekRestricted: parsed.daysOfWeek.size !== 7
  }
}

/** Walks both readings over the same calendar so the comparison is which days, not how many. */
function compareMatchingDays(
  previous: ParsedCron,
  current: ParsedCron,
  anchor: number
): { previousDays: number; currentDays: number; sameDays: boolean } {
  const cursor = new Date(anchor)
  cursor.setHours(12, 0, 0, 0)
  let previousDays = 0
  let currentDays = 0
  let sameDays = true
  for (let i = 0; i < DRIFT_SCAN_DAYS; i += 1) {
    const at = cursor.getTime()
    const previousMatch = cronDateMatches(previous, at)
    const currentMatch = cronDateMatches(current, at)
    if (previousMatch) {
      previousDays += 1
    }
    if (currentMatch) {
      currentDays += 1
    }
    if (previousMatch !== currentMatch) {
      sameDays = false
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return { previousDays, currentDays, sameDays }
}

function runsPerYear(rule: ParsedCron, days: number): number {
  return Math.round((days / 2) * rule.hours.size * rule.minutes.size)
}

/** Only changed cron cadence drifts; RRULE presets bypassed the repaired parser. */
export function describeAutomationScheduleDrift(
  schedule: string,
  anchor = Date.now()
): AutomationScheduleDrift | null {
  const expression = schedule.trim()
  if (expression.includes('=')) {
    return null
  }
  let current: ParsedCron
  let previous: ParsedCron
  try {
    current = parseCronExpression(expression)
    previous = parsePreRepairCron(expression)
  } catch {
    // An unreadable schedule drifts nowhere; the tick reports it separately (#16303).
    return null
  }
  const sameClock =
    previous.minutes.size === current.minutes.size &&
    previous.hours.size === current.hours.size &&
    [...current.minutes].every((minute) => previous.minutes.has(minute)) &&
    [...current.hours].every((hour) => previous.hours.has(hour))
  const { previousDays, currentDays, sameDays } = compareMatchingDays(previous, current, anchor)
  // Compare actual fire dates, not changed restriction flags with unchanged cadence.
  if (sameClock && sameDays) {
    return null
  }
  return {
    expression,
    previousRunsPerYear: runsPerYear(previous, previousDays),
    currentRunsPerYear: runsPerYear(current, currentDays)
  }
}
