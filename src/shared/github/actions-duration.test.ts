import { describe, expect, it } from 'vitest'
import { completedDurationSeconds } from './actions-duration'
describe('completed job duration', () => {
  it('never derives elapsed time from absent, invalid or reversed timestamps', () => {
    expect(completedDurationSeconds('2026-09-30T01:00:00Z', null)).toBeNull()
    expect(completedDurationSeconds('invalid', '2026-09-30T01:00:00Z')).toBeNull()
    expect(completedDurationSeconds('2026-09-30T01:00:01Z', '2026-09-30T01:00:00Z')).toBeNull()
    expect(completedDurationSeconds('2026-09-30T01:00:00Z', '2026-09-30T01:00:10Z')).toBe(10)
  })
})
