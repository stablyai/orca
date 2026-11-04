import { it, expect } from 'vitest'
import { normalizeAgentStatusPayload } from './agent-status-types'

it('carries typed quota only on a failed finished root, including an unknown reset', () => {
  const mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: 5, usageLimit: {} }
  expect(normalizeAgentStatusPayload({ state: 'working', mainAgent })?.mainAgent).toEqual(mainAgent)
  for (const changed of [{ state: 'working' }, { outcome: 'cancellation' }]) {
    expect(
      normalizeAgentStatusPayload({ state: 'working', mainAgent: { ...mainAgent, ...changed } })
        ?.mainAgent?.usageLimit
    ).toBeUndefined()
  }
})
