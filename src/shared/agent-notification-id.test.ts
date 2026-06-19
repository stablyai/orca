import { describe, expect, it } from 'vitest'
import { buildAgentNotificationId } from './agent-notification-id'

describe('buildAgentNotificationId', () => {
  it('builds a stable id for the same agent event metadata', () => {
    const args = {
      worktreeId: 'repo::/Users/me/orca/workspaces/feature',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      stateStartedAt: 1780000000123
    }

    expect(buildAgentNotificationId(args)).toBe(buildAgentNotificationId(args))
  })

  it('changes when the agent state start time changes', () => {
    const base = {
      worktreeId: 'repo::/Users/me/orca/workspaces/feature',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
    }

    expect(buildAgentNotificationId({ ...base, stateStartedAt: 1780000000123 })).not.toBe(
      buildAgentNotificationId({ ...base, stateStartedAt: 1780000000456 })
    )
  })

  it('returns null when required fields are missing', () => {
    expect(
      buildAgentNotificationId({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        stateStartedAt: 1780000000123
      })
    ).toBeNull()
    expect(
      buildAgentNotificationId({
        worktreeId: 'repo::/Users/me/orca/workspaces/feature',
        stateStartedAt: 1780000000123
      })
    ).toBeNull()
    expect(
      buildAgentNotificationId({
        worktreeId: 'repo::/Users/me/orca/workspaces/feature',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
      })
    ).toBeNull()
  })
})
