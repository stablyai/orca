import { describe, expect, it } from 'vitest'
import { resolveBackgroundAgentLaunchRecovery } from './background-agent-launch-recovery'
import type { BackgroundAgentLaunchAttempt } from '../../../shared/background-agent-launch'
import type {
  AgentLaunchFailureCode,
  PersistedAgentLaunchFailure
} from '../../../shared/agent-launch-contract'

function persistedFailure(code: AgentLaunchFailureCode): PersistedAgentLaunchFailure {
  return { code, version: 1, failureId: 'f1', intent: 'background', occurredAt: 0 }
}

function attempt(
  overrides: Partial<BackgroundAgentLaunchAttempt> = {}
): BackgroundAgentLaunchAttempt {
  return {
    attemptId: 'a1',
    worktreeId: 'wt-1',
    operationId: 'op-1',
    requestedAgent: 'claude',
    baseAgent: 'claude',
    state: 'failed',
    failure: persistedFailure('spawn_failed'),
    createdAt: 0,
    updatedAt: 0,
    forgottenAt: null,
    ...overrides
  }
}

describe('resolveBackgroundAgentLaunchRecovery', () => {
  it('resolves the code-based recovery row for a failed attempt (idle liveness)', () => {
    const result = resolveBackgroundAgentLaunchRecovery(attempt({ state: 'failed' }))
    expect(result).not.toBeNull()
    expect(result?.failure.code).toBe('spawn_failed')
    expect(result?.model).toEqual({ primary: 'retry', secondary: ['choose-agent'] })
  })

  it('offers Reconnect + Forget for a pending attempt stranded in launch_state_unknown', () => {
    const result = resolveBackgroundAgentLaunchRecovery(
      attempt({ state: 'pending', failure: persistedFailure('launch_state_unknown') })
    )
    expect(result?.model).toEqual({ primary: 'reconnect', secondary: ['forget-launch'] })
  })

  it('surfaces no card for a launched attempt', () => {
    expect(
      resolveBackgroundAgentLaunchRecovery(attempt({ state: 'launched', failure: null }))
    ).toBeNull()
  })

  it('surfaces no card for a forgotten attempt even if a failure is retained', () => {
    expect(
      resolveBackgroundAgentLaunchRecovery(
        attempt({
          state: 'forgotten',
          forgottenAt: 1,
          failure: persistedFailure('launch_state_unknown')
        })
      )
    ).toBeNull()
  })

  it('surfaces no card for a pending attempt with no failure yet', () => {
    expect(
      resolveBackgroundAgentLaunchRecovery(attempt({ state: 'pending', failure: null }))
    ).toBeNull()
  })
})
