import { describe, expect, it } from 'vitest'
import { agentReferenceToken } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from './native-chat-agent-reference-send'

const chip = (label: string, address: string, kind?: string) => ({
  type: 'nativeChatAgentReference',
  attrs: { label, address, hostKey: 'local', ...(kind ? { kind } : {}) }
})

describe('serializeNativeChatAgentReferences', () => {
  it('tells the agent how to read and reach each picked chat, terminal and crew agent', () => {
    const picked = [
      chip('Fix login', 'orca_session_id:s2', 'chat'),
      chip('dev server', 'term_dev', 'terminal'),
      chip('auth-tests', 'term_w1')
    ]
    const content = picked.flatMap((node, index) => [
      { type: 'text', text: index === 0 ? 'ask ' : ' and ' },
      node
    ])
    const text = `ask ${picked
      .map(({ attrs: { label, address } }) =>
        agentReferenceToken({ label, address, hostKey: 'local' })
      )
      .join(' and ')}`

    expect(
      serializeNativeChatAgentReferences(text, {
        type: 'doc',
        content: [{ type: 'paragraph', content }]
      })
    ).toBe(
      [
        'ask @Fix login and @dev server and @auth-tests',
        '',
        '[Orca chat "Fix login": orca_session_id:s2 — read it with orca agent read orca_session_id:s2, and message it with orca orchestration send --to orca_session_id:s2 --subject "<topic>" --body "<message>"]',
        '[Orca terminal "dev server": term_dev — read it with orca terminal read --terminal term_dev, and type into it with orca terminal send --terminal term_dev --text "<text>" --enter]',
        '[Orca agent "auth-tests": term_w1 — message it with orca orchestration send --to term_w1 --subject "<topic>" --body "<message>"]'
      ].join('\n')
    )
  })
})
