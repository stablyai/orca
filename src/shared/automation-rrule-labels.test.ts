import { describe, expect, it } from 'vitest'
import { describeAutomationSchedule, formatAutomationSchedule } from './automation-schedules'
import { isValidAutomationSchedule } from './automation-schedule-parsing'

describe('valid RRULEs outside the simple editor presets', () => {
  it.each(['MO,WE', 'SA,SU', 'FR,TH,WE,TU,MO', 'SU,MO,TU,WE,TH,FR,SA'])(
    'describes a valid weekly rule for %s as custom',
    (days) => {
      const schedule = `FREQ=WEEKLY;BYDAY=${days};BYHOUR=9;BYMINUTE=0`
      expect(isValidAutomationSchedule(schedule)).toBe(true)
      expect(describeAutomationSchedule(schedule)).toEqual({ kind: 'custom' })
      expect(formatAutomationSchedule(schedule)).toBe('Custom schedule')
    }
  )

  it.each(['FREQ=WEEKLY;BYDAY=NO', 'FREQ=WEEKLY', 'FREQ=YEARLY'])(
    'still reports malformed or unsupported rules as invalid: %s',
    (schedule) => {
      expect(describeAutomationSchedule(schedule)).toEqual({ kind: 'invalid' })
      expect(formatAutomationSchedule(schedule)).toBe('Invalid schedule')
    }
  )
})
