import { describe, expect, it } from 'vitest'
import { agentStopDisplayStatus } from './agent-stop-display-status'

describe('agentStopDisplayStatus', () => {
  it("reads stopping from the host's flag or this client's own press while the agent works", () => {
    expect(agentStopDisplayStatus({ working: true, hostStopping: true })).toBe('stopping')
    expect(agentStopDisplayStatus({ working: true, stopPressed: true })).toBe('stopping')
    expect(agentStopDisplayStatus({ working: true })).toBe('working')
  })

  it('never reads stopping on an agent that is not working', () => {
    expect(agentStopDisplayStatus({ working: false, hostStopping: true, stopPressed: true })).toBe(
      'not-working'
    )
  })
})
