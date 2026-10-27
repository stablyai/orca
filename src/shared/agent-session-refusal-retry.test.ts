import { describe, expect, it } from 'vitest'
import type { AgentSessionOwnerVerdict } from './agent-session-wire'
import { agentSessionOwnerVerdictAllowsFreshOperationId } from './agent-session-refusal-retry'

describe("the owner's verdict decides a retry's operation id only as a floor", () => {
  it('lets a retry use a new id once the stored verdict proves nothing runs', () => {
    expect(agentSessionOwnerVerdictAllowsFreshOperationId('exited')).toBe(true)
  })

  it.each<AgentSessionOwnerVerdict | undefined>(['unverifiable', 'live', undefined])(
    'keeps the id for a stored %s verdict, whose operation may still land',
    (stored) => {
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored)).toBe(false)
    }
  )

  it.each<AgentSessionOwnerVerdict | undefined>(['unverifiable', 'live', undefined])(
    'moves off a stored %s verdict only when the current lease proves the owner exited',
    (stored) => {
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored, 'exited')).toBe(true)
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored, 'unverifiable')).toBe(false)
      expect(agentSessionOwnerVerdictAllowsFreshOperationId(stored, 'live')).toBe(false)
    }
  )

  it('never lowers a stored exited', () => {
    expect(agentSessionOwnerVerdictAllowsFreshOperationId('exited', 'live')).toBe(true)
    expect(agentSessionOwnerVerdictAllowsFreshOperationId('exited', 'unverifiable')).toBe(true)
  })
})
