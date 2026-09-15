import { beforeEach, describe, expect, it } from 'vitest'
import { settleStructuredAgentSurfaceProducer } from './structured-agent-surface-production'
import {
  consumeWorkspaceSurfaceProducerAttempt,
  readWorkspaceSurfaceProducerEntries,
  registerWorkspaceSurfaceProducer,
  resetWorkspaceSurfaceProducersForTests
} from './workspace-surface-production'

const WORKSPACE_KEY = 'worktree-1'

function producer(attemptId: string) {
  return registerWorkspaceSurfaceProducer({
    workspaceKey: WORKSPACE_KEY,
    executionHostId: 'local',
    attemptId
  })
}

beforeEach(() => {
  resetWorkspaceSurfaceProducersForTests()
})

describe('structured agent surface production', () => {
  it.each([
    ['visibility-unknown', { kind: 'visibility-unknown', sessionId: 'session-1' }],
    ['cancelled', { kind: 'cancelled', sessionId: 'session-1' }]
  ] as const)('retains %s execution ownership as unverifiable', (_label, settlement) => {
    const attempt = producer(`attempt-${_label}`)

    settleStructuredAgentSurfaceProducer(attempt, WORKSPACE_KEY, settlement)
    consumeWorkspaceSurfaceProducerAttempt(attempt.attempt.id)

    expect(readWorkspaceSurfaceProducerEntries(attempt.attempt)).toMatchObject([
      { result: { kind: 'unverifiable' } }
    ])
  })

  it('carries a definitive structured launch failure to recovery', () => {
    const attempt = producer('failed-attempt')

    settleStructuredAgentSurfaceProducer(attempt, WORKSPACE_KEY, {
      kind: 'failed',
      error: new Error('provider unavailable')
    })

    expect(readWorkspaceSurfaceProducerEntries(attempt.attempt)).toMatchObject([
      { result: { kind: 'failed', reason: 'provider unavailable' } }
    ])
  })

  it('carries the exact structured tab identity to inventory reconciliation', () => {
    const attempt = producer('published-attempt')

    settleStructuredAgentSurfaceProducer(attempt, WORKSPACE_KEY, {
      kind: 'structured',
      sessionId: 'session-1'
    })

    expect(readWorkspaceSurfaceProducerEntries(attempt.attempt)).toMatchObject([
      {
        result: {
          kind: 'materialized',
          surface: { kind: 'tab', id: 'agent-session:session-1' }
        }
      }
    ])
  })
})
