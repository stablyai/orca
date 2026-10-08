import { describe, expect, it } from 'vitest'
import { describeAutomationScheduleDrift } from './automation-schedule-drift'

// Both lists were recorded by running the same corpus through the real parent build
// (729491597f3) and this branch, not by re-deriving them from the detector under test.
const DRIFTED = [
  '5/15 * * * *',
  '0/30 * * * *',
  '5/15 9 * * *',
  '0 9/4 * * *',
  '0 9 1/7 * *',
  '0 9 * 1/3 *',
  '0 9 * * 1/2',
  '0 9 1-31 * 1',
  '0 9 */2 * 1',
  '0 9 */3 * 1',
  '0 9 * MAR/3 *'
]

const STABLE = [
  '0 * * * *',
  '30 9 * * *',
  '30 9 * * 1-5',
  '30 9 * * 3',
  '*/15 * * * *',
  '*/5 * * * *',
  '5 * * * *',
  '0 9 */1 * 1',
  '0 9 1,15 * 1',
  '0 9 * * 0-6',
  '0 9 * * 0-7',
  '0 9 * * 1-7',
  '0 9 */2 * *',
  '0 9 * * */2',
  '0 9 1-31 * *',
  '0 9 * * *',
  '0 9 15 * *',
  '0 9 1-15 * 1',
  '*/90 * * * *',
  '5/90 * * * *',
  '0 9 * * */8',
  '0 9 * MAY MON',
  '0 9 * * FRI'
]

const ANCHOR = new Date(2026, 0, 1).getTime()

describe('automation schedule drift', () => {
  it('flags every schedule the repair changed', () => {
    for (const expression of DRIFTED) {
      expect(describeAutomationScheduleDrift(expression, ANCHOR), expression).not.toBeNull()
    }
  })

  // The restriction flags move on several of these while the days they fire do not; reporting
  // those would train the reader to ignore the notice.
  it('stays silent on schedules the repair left alone', () => {
    for (const expression of STABLE) {
      expect(describeAutomationScheduleDrift(expression, ANCHOR), expression).toBeNull()
    }
  })

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

  it('ignores RRULE presets, which never used the repaired parser', () => {
    expect(describeAutomationScheduleDrift('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', ANCHOR)).toBeNull()
  })

  it('reports nothing for a schedule that cannot be read at all', () => {
    expect(describeAutomationScheduleDrift('0 9 32 * *', ANCHOR)).toBeNull()
    expect(describeAutomationScheduleDrift('not a cron', ANCHOR)).toBeNull()
  })
})
