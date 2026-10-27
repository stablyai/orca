import { describe, expect, it } from 'vitest'
import { resolveOrchestrationHeartbeatMinutes } from './orchestration-heartbeat'

describe('resolveOrchestrationHeartbeatMinutes', () => {
  it.each([0, 61, 2.5, Number.NaN])('falls back to 5 for a malformed interval (%s)', (value) => {
    expect(
      resolveOrchestrationHeartbeatMinutes({ orchestrationHeartbeatIntervalMinutes: value })
    ).toBe(5)
  })
})
