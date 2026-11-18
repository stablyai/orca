import { expect, it } from 'vitest'
import { readAgentMessageSource, type AgentMessageSource } from './agent-session-message-source'

it('retains peer provenance when a newer or damaged link label cannot be read', () => {
  const source: AgentMessageSource = {
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
  const link = { id: 'pair', title: 'Slice 1b', eventId: 'report' }
  expect(readAgentMessageSource({ ...source, link })).toMatchObject({ kind: 'agent', link })
  expect(readAgentMessageSource({ ...source, link: { id: 42 } })).toMatchObject({ kind: 'agent' })
})
