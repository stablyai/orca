import { describe, expect, it } from 'vitest'
import { cronMatches } from './automation-cron-occurrence'
import { parseCronExpression } from './automation-schedule-parsing'

const ascending = (values: Set<number>): number[] => [...values].sort((left, right) => left - right)

const EVERY_DAY_OF_MAY = Array.from({ length: 31 }, (_, index) => index + 1)

/** Independent May 2026 calendar oracle: Mondays 4/11/18/25, Sundays 3/10/17/24/31, weekends 2/3, 9/10, 16/17, 23/24, 30/31. Never derive expectations through the parser. */
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
})

describe('cron day restriction (#15896)', () => {
  // A day field restricts only without any star term. Match both restricted fields with OR, otherwise AND; independent expectations come from robfig/cron v1.2.0.
  it('ORs an explicit full day-of-month range against a restricted day-of-week', () => {
    expect(matchingDaysOfMay2026('0 9 1-31 * 1')).toEqual(EVERY_DAY_OF_MAY)
  })

  // Star steps remain unrestricted: OR would schedule 18 odd-or-Monday dates instead of the two matching both.
  it('keeps AND when a day field steps over a star', () => {
    expect(matchingDaysOfMay2026('0 9 */2 * 1')).toEqual([11, 25])
    expect(matchingDaysOfMay2026('0 9 */1 * 1')).toEqual([4, 11, 18, 25])
    expect(matchingDaysOfMay2026('0 9 * * */2')).toEqual([
      2, 3, 5, 7, 9, 10, 12, 14, 16, 17, 19, 21, 23, 24, 26, 28, 30, 31
    ])
  })

  // The star test is per comma term, so a list that reaches a star anywhere is unrestricted.
  it('treats a day list containing a star term as a star', () => {
    expect(matchingDaysOfMay2026('0 9 2,*/3 * 1,5')).toEqual([1, 4, 22, 25])
  })
})
