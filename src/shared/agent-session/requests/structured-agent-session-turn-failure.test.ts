import { expect, it } from 'vitest'
import { agentSessionFailureFact } from '../failures/agent-session-failure'
import { structuredAgentSessionRefusalLine } from './structured-agent-session-turn-failure'

it('names the provider detail once, whether or not the sentence already quotes it', () => {
  const line = (fact: ReturnType<typeof agentSessionFailureFact>) =>
    structuredAgentSessionRefusalLine(fact, 'Codex')
  expect(
    line(
      agentSessionFailureFact('providerRejected', {
        detail: { text: 'Model gpt-x is not available.', audience: 'person' }
      })
    )
  ).toBe("Codex didn't accept this message: Model gpt-x is not available.")
  expect(
    line(
      agentSessionFailureFact('modelUnavailable', { detail: { text: 'gpt-9', audience: 'log' } })
    )
  ).toBe("Codex couldn't use gpt-9. Pick another model and send again.")
  expect(
    line(
      agentSessionFailureFact('startFailed', {
        detail: { text: 'boot failed: NOTION_TOKEN=ntn_abc123', audience: 'log' }
      })
    )
  ).toBe("Codex couldn't start: boot failed: NOTION_TOKEN=[redacted]")
})
