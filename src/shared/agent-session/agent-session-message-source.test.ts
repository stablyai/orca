import { describe, expect, it } from 'vitest'
import { readAgentMessageSource, type AgentMessageSource } from './agent-session-message-source'
import { mailReportSourceLabel } from './mail-report-presentation'
import { testOrcaSessionId } from '../orca-session-address-test-fixture'
import {
  agentMessageSenderCanOpen,
  agentMessageSenderIsNamedSource,
  agentMessageSenderLabel
} from './agent-message-presentation'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
      name: 'Build tab',
      agent: 'claude'
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

it.each([
  ['ci-notifier', undefined, true, false, 'ci-notifier'],
  ['orca-bg-wake', undefined, true, false, 'orca-bg-wake'],
  ['ci-notifier', 'unknown', true, false, 'ci-notifier'],
  ['term_gone', undefined, false, true, 'Terminal'],
  ['structworker_gone', undefined, false, true, 'Terminal'],
  [`orca_session_id:${SESSION}`, undefined, false, true, 'an agent'],
  ['dispatch:gone', undefined, false, false, 'an agent'],
  ...['claude', 'codex', 'grok', 'future-agent'].map(
    (agent) => ['sender', agent, false, true, 'an agent'] as const
  )
] as const)(
  'presents %s (%s) from its saved identity, independent of live availability',
  (address, agent, named, opens, label) => {
    const sender = {
      party: { address, terminalHandle: address, orcaSessionId: null },
      name: null,
      ...(agent ? { agent } : {})
    }
    expect(agentMessageSenderIsNamedSource(sender)).toBe(named)
    expect(agentMessageSenderCanOpen(sender)).toBe(opens)
    expect(
      agentMessageSenderLabel({
        sender,
        localChat: false,
        fallback: 'an agent',
        terminalFallback: 'Terminal'
      })
    ).toBe(label)
  }
)

it('preserves observed name precedence and external identity while neutralizing unnamed terminal reports', () => {
  const sender = {
    party: { address: 'term_plain', terminalHandle: 'term_plain', orcaSessionId: null },
    name: null
  }
  const facts = { sender, localChat: true, fallback: 'an agent', terminalFallback: 'Terminal' }
  expect(
    agentMessageSenderLabel({
      ...facts,
      customLabel: ' Custom ',
      conversationName: 'Conversation',
      snapshotName: 'Saved',
      tabLabel: 'Tab'
    })
  ).toBe('Custom')
  expect(
    agentMessageSenderLabel({
      ...facts,
      conversationName: 'Conversation',
      snapshotName: 'Saved',
      tabLabel: 'Tab'
    })
  ).toBe('Conversation')
  expect(agentMessageSenderLabel({ ...facts, snapshotName: 'Saved', tabLabel: 'Tab' })).toBe(
    'Saved'
  )
  expect(agentMessageSenderLabel({ ...facts, tabLabel: ' Tab ' })).toBe('Tab')
  expect(agentMessageSenderLabel({ ...facts, sender: { ...sender, relation: 'worker' } })).toBe(
    'an agent'
  )
  const external = { ...sender, party: { ...sender.party, address: 'ci-notifier' } }
  expect(agentMessageSenderLabel({ ...facts, sender: external })).toBe('ci-notifier')
  expect(mailReportSourceLabel([sender, { ...sender, name: 'Setup' }, external], 'Terminal')).toBe(
    'Terminal, Setup, ci-notifier'
  )
  expect(mailReportSourceLabel([sender], 'Terminal traduit')).toBe('Terminal traduit')
  expect(mailReportSourceLabel([{ ...sender, agent: 'claude' }], 'Terminal')).toBe('term_plain')
})

it('bounds and normalizes a named source without making invisible addresses an agent', () => {
  const sender = {
    party: { address: `ci\n${'x'.repeat(300)}`, terminalHandle: null, orcaSessionId: null },
    name: null
  }
  expect(agentMessageSenderLabel({ sender, localChat: false, fallback: 'an agent' })).toBe(
    `ci ${'x'.repeat(197)}`
  )
  expect(
    agentMessageSenderLabel({
      sender: { ...sender, party: { ...sender.party, address: '  ' } },
      localChat: false,
      fallback: 'an agent'
    })
  ).toBe('—')
})

describe("a message's sender, read through its one reader", () => {
  it("reads a Dispatch's task back whole", () => {
    const task: AgentMessageSource = {
      ...FROM,
      orchestration: { message: 'task', runId: 'r1', taskId: 't1', dispatchId: 'ctx_1' }
    }
    expect(readAgentMessageSource(structuredClone(task))).toEqual(task)
    const parsed = readAgentMessageSource({
      ...task,
      senders: FROM.senders.map((sender) => ({ ...sender, relation: 'future' }))
    })
    expect(parsed).toEqual(task)
  })

  it("keeps a sender's agent this build does not know, and drops only an unreadable one", () => {
    const withAgent = (agent: unknown) =>
      readAgentMessageSource({ ...FROM, senders: [{ ...FROM.senders[0], agent }] })?.senders[0]
    expect(withAgent('future-agent')?.agent).toBe('future-agent')
    expect(withAgent('x'.repeat(200))).toEqual({ ...FROM.senders[0], agent: undefined })
    expect(withAgent(7)?.name).toBe('Build tab')
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
})
