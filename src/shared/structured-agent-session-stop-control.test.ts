import { expect, it } from 'vitest'
import { structuredAgentSessionCanStop } from './structured-agent-session-stop-control'

it('offers Stop for a message setup holds, though the host shows it as not working', () => {
  const held = { turnId: null, isWorking: false, sending: false, heldForSetup: true }
  expect(structuredAgentSessionCanStop({ ...held, stopsConversation: true })).toBe(true)
  // A host that can't stop a turnless conversation has nothing for Stop to name.
  expect(structuredAgentSessionCanStop({ ...held, stopsConversation: false })).toBe(false)
  expect(
    structuredAgentSessionCanStop({ ...held, heldForSetup: false, stopsConversation: true })
  ).toBe(false)
})
