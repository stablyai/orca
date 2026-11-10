import { describe, expect, it } from 'vitest'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { SLEEP_COOLDOWN_MS } from './cloud-predictive-wake'
import { predictiveWakeServerVerdict } from './cloud-predictive-wake-preflight'

const NOW = 1_800_000_000_000
const limit = { perSeat: 3, team: 9 }

function status(over: Partial<HostedWorkspaceStatus> = {}): HostedWorkspaceStatus {
  return {
    state: 'sleeping',
    metrics: null,
    uptimeMs: null,
    usage: { totalMs: 0, centsPerHour: 20, costCents: 0 },
    archive: null,
    checkedAt: NOW,
    lastUserSleepAt: null,
    running: { owner: 0, account: 0 },
    ...over
  }
}

describe('predictive wake server preflight', () => {
  it('allows a sleeping workspace with room on the seat and the team', () => {
    expect(predictiveWakeServerVerdict(status({ running: { owner: 1, account: 7 } }), limit)).toBe(
      'ok'
    )
  })

  it('skips anything not asleep, and an unread status', () => {
    expect(predictiveWakeServerVerdict(status({ state: 'ready' }), limit)).toBe('not-sleeping')
    expect(predictiveWakeServerVerdict(null, limit)).toBe('not-sleeping')
  })

  it('honours a sleep chosen on any client for the cooldown, on the server clock', () => {
    const slept = (ago: number) => status({ lastUserSleepAt: NOW - ago })
    expect(predictiveWakeServerVerdict(slept(5_000), limit)).toBe('recently-slept')
    expect(predictiveWakeServerVerdict(slept(SLEEP_COOLDOWN_MS - 1), limit)).toBe('recently-slept')
    expect(predictiveWakeServerVerdict(slept(SLEEP_COOLDOWN_MS), limit)).toBe('ok')
  })

  it("keeps the owner seat's last slot: skips at or one below the per-seat cap", () => {
    expect(predictiveWakeServerVerdict(status({ running: { owner: 2, account: 2 } }), limit)).toBe(
      'seat-near-cap'
    )
    expect(predictiveWakeServerVerdict(status({ running: { owner: 3, account: 3 } }), limit)).toBe(
      'seat-near-cap'
    )
  })

  it("keeps the team's last slot too", () => {
    expect(predictiveWakeServerVerdict(status({ running: { owner: 0, account: 8 } }), limit)).toBe(
      'team-near-cap'
    )
  })

  it('falls back to local checks when the control plane or billing does not say', () => {
    const old = status({ running: undefined, lastUserSleepAt: undefined })
    expect(predictiveWakeServerVerdict(old, limit)).toBe('ok')
    expect(predictiveWakeServerVerdict(status({ running: { owner: 2, account: 8 } }), null)).toBe(
      'ok'
    )
  })
})
