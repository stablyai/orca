import { describe, expect, it } from 'vitest'
import { describeAutomationScheduleDrift } from './automation-schedule-drift'

const ANCHOR = new Date(2026, 0, 1).getTime()

describe('automation schedule drift', () => {
  it('reports the direction and size of the change', () => {
    // 1x/hour -> 4x/hour: the cadence users will feel as spend.
    expect(describeAutomationScheduleDrift('5/15 * * * *', ANCHOR)).toEqual({
      expression: '5/15 * * * *',
      previousRunsPerYear: 8760,
      currentRunsPerYear: 35040
    })
    // The quiet direction: an automation that now skips most of the days it used to run.
    const fewer = describeAutomationScheduleDrift('0 9 */2 * 1', ANCHOR)
    expect(fewer!.currentRunsPerYear).toBeLessThan(fewer!.previousRunsPerYear / 4)
  })
})
