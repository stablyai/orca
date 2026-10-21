import { describe, expect, it } from 'vitest'
import { cronMatches } from './automation-cron-occurrence'
import { parseCronExpression } from './automation-schedule-parsing'

const ascending = (values: Set<number>): number[] => [...values].sort((left, right) => left - right)

const EVERY_DAY_OF_MAY = Array.from({ length: 31 }, (_, index) => index + 1)

/**
 * Independent calendar oracle. May 2026 opens on a Friday, so its Mondays are 4/11/18/25,
 * its Sundays 3/10/17/24/31, and its weekend days 2/3, 9/10, 16/17, 23/24 and 30/31. Every
 * expectation below is that hand calendar, never a second call into the parser.
 */
function matchingDaysOfMay2026(expression: string): number[] {
  const rule = parseCronExpression(expression)
  const days: number[] = []
  for (let day = 1; day <= 31; day += 1) {
    if (cronMatches(rule, new Date(2026, 4, day, 9, 0, 0, 0).getTime())) {
      days.push(day)
    }
  }
  return days
}

describe('cron bare stepped values (#15723)', () => {
  it('expands `N/step` as the open-ended `N-max/step` sequence in every field', () => {
    expect(ascending(parseCronExpression('5/15 * * * *').minutes)).toEqual([5, 20, 35, 50])
    expect(ascending(parseCronExpression('* 2/7 * * *').hours)).toEqual([2, 9, 16, 23])
    expect(ascending(parseCronExpression('0 9 5/10 * *').daysOfMonth)).toEqual([5, 15, 25])
    expect(ascending(parseCronExpression('0 9 * MAR/3 *').months)).toEqual([3, 6, 9, 12])
    // 1, 4 and 7, with Sunday normalized off 7.
    expect(ascending(parseCronExpression('0 9 * * 1/3').daysOfWeek)).toEqual([0, 1, 4])
  })

  it('matches the explicit `N-max/step` range it is defined to mean', () => {
    const equivalents: [string, string][] = [
      ['5/15 * * * *', '5-59/15 * * * *'],
      ['* 2/7 * * *', '* 2-23/7 * * *'],
      ['0 9 5/10 * *', '0 9 5-31/10 * *'],
      ['0 9 * MAR/3 *', '0 9 * MAR-DEC/3 *'],
      ['0 9 * * 1/3', '0 9 * * 1-7/3']
    ]
    for (const [bare, explicit] of equivalents) {
      const left = parseCronExpression(bare)
      const right = parseCronExpression(explicit)
      expect([
        ascending(left.minutes),
        ascending(left.hours),
        ascending(left.daysOfMonth),
        ascending(left.months),
        ascending(left.daysOfWeek)
      ]).toEqual([
        ascending(right.minutes),
        ascending(right.hours),
        ascending(right.daysOfMonth),
        ascending(right.months),
        ascending(right.daysOfWeek)
      ])
    }
  })

  it('leaves a bare value with no step as itself', () => {
    expect(ascending(parseCronExpression('5 * * * *').minutes)).toEqual([5])
    expect(ascending(parseCronExpression('0 9 5 * *').daysOfMonth)).toEqual([5])
    expect(ascending(parseCronExpression('0 9 * MAR *').months)).toEqual([3])
    expect(ascending(parseCronExpression('0 9 * * FRI').daysOfWeek)).toEqual([5])
  })

  // Separateness probe: the #15723 repair only reaches the bare-value branch, so it moves
  // neither an oversized step nor the day-restriction flags (#15896).
  it('leaves oversized-step and full-range-day expansions exactly where they were', () => {
    expect(ascending(parseCronExpression('*/90 * * * *').minutes)).toEqual([0])
    expect(ascending(parseCronExpression('5/90 * * * *').minutes)).toEqual([5])
    expect(ascending(parseCronExpression('0 9 1-31 * 1').daysOfMonth)).toEqual(EVERY_DAY_OF_MAY)
  })
})

describe('cron day restriction (#15896)', () => {
  // Dialect: a day field is restricted iff no term of it ranges over a star; when both day
  // fields are restricted the day matches on either, otherwise on both. Every expectation
  // below was taken from robfig/cron v1.2.0, an independent implementation of the same rule.
  it('ORs an explicit full day-of-month range against a restricted day-of-week', () => {
    expect(matchingDaysOfMay2026('0 9 1-31 * 1')).toEqual(EVERY_DAY_OF_MAY)
  })

  it('ANDs a wildcard day-of-month against a restricted day-of-week', () => {
    expect(matchingDaysOfMay2026('0 9 * * 1')).toEqual([4, 11, 18, 25])
  })

  it('ORs two partially restricted day fields', () => {
    expect(matchingDaysOfMay2026('0 9 1,15 * 1')).toEqual([1, 4, 11, 15, 18, 25])
  })

  it('ANDs a restricted day-of-month against a wildcard day-of-week', () => {
    expect(matchingDaysOfMay2026('0 9 1,15 * *')).toEqual([1, 15])
  })

  // A star step is still a star, so it does not flip the day rule to OR. Reading `*/2` as
  // restricted would fire this ~8x more: the 18 odd-or-Monday days, not the 2 that are both.
  it('keeps AND when a day field steps over a star', () => {
    expect(matchingDaysOfMay2026('0 9 */2 * 1')).toEqual([11, 25])
    expect(matchingDaysOfMay2026('0 9 */1 * 1')).toEqual([4, 11, 18, 25])
    expect(matchingDaysOfMay2026('0 9 * * */2')).toEqual([
      2, 3, 5, 7, 9, 10, 12, 14, 16, 17, 19, 21, 23, 24, 26, 28, 30, 31
    ])
  })

  // The star test is per comma term, so a list that reaches a star anywhere is unrestricted.
  it('treats a day list containing a star term as a star', () => {
    expect(matchingDaysOfMay2026('0 9 */3 * 1,5')).toEqual([1, 4, 22, 25])
  })

  it('normalizes Sunday from 0, from 7 and from the name', () => {
    expect(matchingDaysOfMay2026('0 9 * * 0')).toEqual([3, 10, 17, 24, 31])
    expect(matchingDaysOfMay2026('0 9 * * 7')).toEqual([3, 10, 17, 24, 31])
    expect(matchingDaysOfMay2026('0 9 * * SUN')).toEqual([3, 10, 17, 24, 31])
  })

  it('reads month and day names on both sides of the restriction rule', () => {
    expect(matchingDaysOfMay2026('0 9 * MAY MON')).toEqual([4, 11, 18, 25])
    expect(matchingDaysOfMay2026('0 9 * JUN MON')).toEqual([])
    expect(matchingDaysOfMay2026('0 9 1-31 MAY MON')).toEqual(EVERY_DAY_OF_MAY)
  })

  // Preset-built schedules always write a literal `*` day-of-month, so they keep AND.
  it('leaves preset-shaped schedules on AND semantics', () => {
    expect(matchingDaysOfMay2026('0 9 * * 1-5')).toEqual([
      1, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 25, 26, 27, 28, 29
    ])
    expect(matchingDaysOfMay2026('0 9 * * *')).toEqual(EVERY_DAY_OF_MAY)
  })
})
