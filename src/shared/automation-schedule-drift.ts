// Detects saved cron schedules whose meaning changed in the release that repaired the parser
// (#15723, #15896). Both repairs were correct, but a persisted cadence can now fire several
// times more — or several times less — than it did yesterday, with nothing to notice it by.
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

/**
 * The pre-repair reading of a field: a bare value carrying a step lost the step, so `5/15`
 * meant `5`. A star or a range kept its step, and is left alone.
 */
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

/**
 * The pre-repair reading of a whole expression. Day restriction came from how many values a
 * field expanded to rather than from what the user wrote, so `1-31` read as unrestricted.
 */
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

/**
 * Null when the saved cadence still means what it did before the repair. Only cron schedules
 * can drift; RRULE presets never went through the repaired field parser.
 */
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
  // Compare what the schedule fires, not how it parsed: the restriction flags move on
  // expressions whose matched days do not, and those are not worth telling anyone about.
  if (sameClock && sameDays) {
    return null
  }
  return {
    expression,
    previousRunsPerYear: runsPerYear(previous, previousDays),
    currentRunsPerYear: runsPerYear(current, currentDays)
  }
}
