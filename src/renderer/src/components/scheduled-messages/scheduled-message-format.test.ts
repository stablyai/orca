import { describe, expect, it } from 'vitest'
import { fromLocalDateTimeInputs, toLocalDateTimeInputs } from './scheduled-message-format'

describe('fromLocalDateTimeInputs', () => {
  it('round-trips a local wall-clock moment', () => {
    const epochMs = new Date(2026, 4, 17, 9, 30, 0, 0).getTime()
    const inputs = toLocalDateTimeInputs(epochMs)
    expect(fromLocalDateTimeInputs(inputs.date, inputs.time)).toBe(epochMs)
  })

  it('refuses a local time the Date constructor would silently move', () => {
    // 30 February rolls into March, and a clock time inside a DST spring-forward
    // gap rolls forward an hour, both without any error. Scheduling a moment the
    // user did not pick is worse than refusing the pair.
    expect(fromLocalDateTimeInputs('2026-02-30', '09:30')).toBeNull()
    expect(fromLocalDateTimeInputs('2026-05-17', '25:00')).toBeNull()
  })

  it('returns null for an incomplete pair', () => {
    expect(fromLocalDateTimeInputs('', '09:30')).toBeNull()
    expect(fromLocalDateTimeInputs('2026-05-17', '')).toBeNull()
    expect(fromLocalDateTimeInputs('not-a-date', '09:30')).toBeNull()
  })
})
