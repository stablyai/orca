import { describe, expect, it } from 'vitest'
import { buildAutomationWorkspaceName } from './automation-workspace-name'

describe('automation run workspace timestamps', () => {
  it.each([
    ['Asia/Kolkata', '2026-11-02T03:30:00Z', '20261102T0900'],
    ['Asia/Kathmandu', '2026-11-02T20:30:00Z', '20261103T0215'],
    ['America/New_York', '2026-03-08T06:59:00Z', '20260308T0159'],
    ['America/New_York', '2026-03-08T07:00:00Z', '20260308T0300']
  ])('uses %s at %s', (timezone, scheduledFor, stamp) => {
    expect(
      buildAutomationWorkspaceName('Weekly pulse run 1', Date.parse(scheduledFor), timezone)
    ).toBe(`auto-weekly-pulse-run-1-${stamp}`)
  })
})
