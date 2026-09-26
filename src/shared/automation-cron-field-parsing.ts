// Orca's cron dialect (vixie/POSIX):
// - `N/step` is the open-ended sequence `N-max/step`; a bare `N` is only itself (#15723).
// - A day field is restricted iff no term of it ranges over a star, so `1-31` restricts but
//   `*/2` does not (#15896). Restriction is lexical: the expanded set cannot tell `1-31` from
//   `*`. When both day fields are restricted the day matches on either; otherwise on both.
// - A field step is bounded by the count of distinct values the field holds; a step of 90 on
//   minutes is one value at :00, never "every 90 minutes" (#15895).
export type CronParseOptions = {
  /** Input-time gate: reject a step wider than the field's domain instead of silently
   *  degenerating to a single value. Off for persisted rows, which must keep running the
   *  cadence they were saved with rather than start throwing mid-tick. */
  rejectOversizedStep?: boolean
}

export const MONTH_NAMES: Record<string, number> = {
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

export const DAY_NAMES: Record<string, number> = {
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

export function parseCronField(args: {
  value: string
  min: number
  max: number
  field: string
  names?: Record<string, number>
  normalize?: (value: number) => number
  // Distinct values the field holds, when `normalize` aliases some away — day of week
  // spans 0-7 but holds seven days, so `*/8` is oversized even though 8 <= 7-0+1.
  distinctValueCount?: number
  rejectOversizedStep?: boolean
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
    const domainSize = args.distinctValueCount ?? args.max - args.min + 1
    if (args.rejectOversizedStep && step > domainSize) {
      throw new Error(`Cron ${args.field} step must be between 1 and ${domainSize}.`)
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
      // `N/step` is the open-ended `N-max/step` sequence; a bare `N` is only itself.
      end = stepPart === undefined ? start : args.max
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

// A day field restricts iff none of its terms ranges over a star, matching what vixie cron
// and robfig/cron both do. crontab(5) says "restricted (ie, are not *)", which reads as a
// literal-`*` test, but vixie's own entry.c sets DOM_STAR/DOW_STAR off the field's leading
// character, so `*/2` is a star there too; we follow the implementations over the prose,
// because reading `*/2` as restricted flips its day rule to OR and fires it ~8x more.
export function isCronDayFieldRestricted(field: string): boolean {
  return !field.split(',').some((term) => term.split('/')[0].trim() === '*')
}
