import { describe, expect, it } from 'vitest'
import {
  agentMessageSendersShown,
  readAgentMessageSource,
  type AgentMessageSource
} from './agent-session-message-source'
import { testOrcaSessionId } from './orca-session-address-test-fixture'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
      name: 'Build tab'
    },
    {
      party: {
        address: `orca_session_id:${SESSION}`,
        terminalHandle: null,
        orcaSessionId: testOrcaSessionId(SESSION)
      },
      name: null
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'run:r1',
    dispatchId: null,
    messages: [{ messageId: 'm1', runId: 'r1', from: 'term_a' }]
  }
}

describe("a message's sender, read through its one reader", () => {
  it('reads absence as the person, and a valid sender back whole', () => {
    expect(readAgentMessageSource(undefined)).toBeUndefined()
    expect(readAgentMessageSource(structuredClone(FROM))).toEqual(FROM)
  })

  it("reads a Dispatch's task back whole", () => {
    const task: AgentMessageSource = {
      ...FROM,
      orchestration: { message: 'task', runId: 'r1', taskId: 't1', dispatchId: 'ctx_1' }
    }
    expect(readAgentMessageSource(structuredClone(task))).toEqual(task)
  })

  it('keeps an agent an agent when its orchestration kind is newer than this build', () => {
    const newer = { ...FROM, orchestration: { message: 'review', dispatchId: 'ctx_1' } }
    expect(readAgentMessageSource(newer)).toEqual({ ...FROM, orchestration: null })
    // A newer sender kind is still not the person.
    expect(readAgentMessageSource({ ...FROM, kind: 'automation' })).toMatchObject({
      kind: 'agent'
    })
  })

  it('drops a sender it cannot read and bounds a name, keeping the rest', () => {
    const read = readAgentMessageSource({
      ...FROM,
      senders: [
        { party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: 'term_a' } },
        { party: { address: 'term_b', terminalHandle: 'term_b', orcaSessionId: null }, name: 7 },
        {
          party: { address: 'term_c', terminalHandle: 'term_c', orcaSessionId: null },
          name: `a‮b\n${'x'.repeat(300)}`
        }
      ]
    })
    expect(read?.senders.map(({ party, name }) => [party.address, name?.length ?? null])).toEqual([
      ['term_b', null],
      ['term_c', 200]
    ])
    expect(read?.senders[1]?.name?.startsWith('a b ')).toBe(true)
  })

  it("reads a value that is not a sender at all as the person's message", () => {
    for (const value of [null, 'nobody', 42, [], { senders: [] }]) {
      expect(readAgentMessageSource(value)).toBeUndefined()
    }
  })

  it('names at most a few senders and counts the rest', () => {
    const many: AgentMessageSource = {
      ...FROM,
      senders: Array.from({ length: 5 }, (_, index) => ({
        party: { address: `term_${index}`, terminalHandle: `term_${index}`, orcaSessionId: null },
        name: `Agent ${index}`
      }))
    }
    const { shown, more } = agentMessageSendersShown(many)
    expect(shown.map((sender) => sender.name)).toEqual(['Agent 0', 'Agent 1', 'Agent 2'])
    expect(more).toBe(2)
  })
})
