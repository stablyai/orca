import { describe, expect, it } from 'vitest'
import { structuredAgentSessionWriteNamesItsTarget } from './structured-agent-session-operation-identity'

describe('structuredAgentSessionWriteNamesItsTarget', () => {
  it('holds for a cancel naming its turn, prompt or task, as every mobile cancel does', () => {
    expect(structuredAgentSessionWriteNamesItsTarget('agentSession.cancel', { turnId: 't' })).toBe(
      true
    )
    expect(
      structuredAgentSessionWriteNamesItsTarget('agentSession.cancel', {
        turnId: 't',
        prompt: { itemId: 'i', expectedRevision: 1 }
      })
    ).toBe(true)
    expect(
      structuredAgentSessionWriteNamesItsTarget('agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        taskId: 'task-1'
      })
    ).toBe(true)
  })

  it('fails for a Stop naming no turn, and for a stop of every background task', () => {
    expect(structuredAgentSessionWriteNamesItsTarget('agentSession.cancel', {})).toBe(false)
    expect(
      structuredAgentSessionWriteNamesItsTarget('agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks'
      })
    ).toBe(false)
  })

  it('leaves every other write as it was', () => {
    expect(
      structuredAgentSessionWriteNamesItsTarget('agentSession.setOption', { key: 'k', value: 'v' })
    ).toBe(true)
  })
})
