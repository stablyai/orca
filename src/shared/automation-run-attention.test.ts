import { describe, expect, it } from 'vitest'
import {
  activateAutomationRunAttention,
  unseenAutomationFailures
} from './automation-run-attention'
import { buildProfileStateCutoverFixture } from '../main/persistence/profile-state-cutover-fixture'

const profile = buildProfileStateCutoverFixture('/fixture')
const failed = { ...profile.automationRuns[0], status: 'dispatch_failed' as const }

describe('automation failure acknowledgement', () => {
  it('seeds legacy failures once but preserves failures saved after activation', () => {
    const activated = activateAutomationRunAttention({ ...profile, automationRuns: [failed] }, 100)
    expect(activated.automationRuns[0].failureSeenAt).toBe(100)
    const later = { ...failed, id: 'later' }
    const reloaded = activateAutomationRunAttention(
      {
        ...activated,
        automationRuns: [...activated.automationRuns, later]
      },
      200
    )
    expect(activateAutomationRunAttention(reloaded, 300)).toBe(reloaded)
    expect(unseenAutomationFailures(reloaded.automationRuns).get(failed.automationId)).toBe(1)
    expect(reloaded.automationRuns[1].failureSeenAt).toBeUndefined()
  })

  it('activates an empty profile before its first failure and counts each retained unseen failure', () => {
    const fresh = activateAutomationRunAttention({ ...profile, automationRuns: [] }, 100)
    expect(fresh.automationFailureSeenVersion).toBe(1)
    const runs = [
      failed,
      { ...failed, id: 'other' },
      { ...failed, id: 'ok', status: 'completed' as const }
    ]
    expect(unseenAutomationFailures(runs).get(failed.automationId)).toBe(2)
    expect(
      unseenAutomationFailures([{ ...failed, failureSeenAt: 200 }, ...runs.slice(1)]).get(
        failed.automationId
      )
    ).toBe(1)
    expect(unseenAutomationFailures(runs.slice(2)).size).toBe(0)
  })
})
