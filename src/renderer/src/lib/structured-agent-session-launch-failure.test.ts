import { expect, it } from 'vitest'
import { AgentSessionRefusalError, refuse } from '../../../shared/agent-session-wire-refusals'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'

it("reads that the switch's own source still writes from the live reply only", () => {
  const reply = (source?: true) =>
    new AgentSessionRefusalError(
      refuse(
        'agent_session_conflict',
        { reason: 'conversationHeldElsewhere', ...(source ? { source } : {}) },
        'held'
      )
    )
  expect(structuredLaunchFailure(reply(true))).toMatchObject({ source: true })
  expect(structuredLaunchFailure(reply())).not.toHaveProperty('source')
})
