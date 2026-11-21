import { expect, it } from 'vitest'
import { readAgentMessageSource, type AgentMessageSource } from './agent-session-message-source'

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
      name: 'Build tab',
      agent: 'claude'
    }
  ],
  orchestration: null
}

it("keeps a host's word that a sender's name is its bot, and drops anything else there", () => {
  const withBot = (bot: unknown) =>
    readAgentMessageSource({ ...FROM, senders: [{ ...FROM.senders[0], bot }] })?.senders[0]
  expect(withBot(true)?.bot).toBe(true)
  expect(withBot('yes')).toEqual({ ...FROM.senders[0], bot: undefined })
})
