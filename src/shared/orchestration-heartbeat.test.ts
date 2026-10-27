import { describe, expect, it } from 'vitest'
import { resolveOrchestrationHeartbeatMinutes } from './orchestration-heartbeat'

describe('resolveOrchestrationHeartbeatMinutes', () => {
  it('keeps the 5-minute default for profiles saved before the settings existed', () => {
    expect(resolveOrchestrationHeartbeatMinutes({})).toBe(5)
  })

  it('uses the chosen interval only while heartbeats are on', () => {
    expect(
      resolveOrchestrationHeartbeatMinutes({ orchestrationHeartbeatIntervalMinutes: 15 })
    ).toBe(15)
    expect(
      resolveOrchestrationHeartbeatMinutes({
        orchestrationHeartbeatsEnabled: false,
        orchestrationHeartbeatIntervalMinutes: 15
      })
    ).toBeNull()
  })

  it.each([0, 61, 2.5, Number.NaN])('falls back to 5 for a malformed interval (%s)', (value) => {
    expect(
      resolveOrchestrationHeartbeatMinutes({ orchestrationHeartbeatIntervalMinutes: value })
    ).toBe(5)
  })
})
