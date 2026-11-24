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
      chip('Fix login', 'orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595', 'chat'),
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
        '[Orca chat "Fix login": orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595 — read it with orca agent read orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595, and message it with orca orchestration send --to orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595 --subject "<topic>" --body "<message>"]',
        '[Orca terminal "dev server": term_dev — read it with orca terminal read --terminal term_dev, and type into it with orca terminal send --terminal term_dev --text "<text>" --enter]',
        '[Orca agent "auth-tests": term_w1 — message it with orca orchestration send --to term_w1 --subject "<topic>" --body "<message>"]'
      ].join('\n')
    )
  })

  it("tells the agent how to page a terminal agent's transcript when the chip names its session", () => {
    const session = 'orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595'
    const text = `ask ${agentReferenceToken({ label: 'codex', address: 'term_codex', hostKey: 'local' })}`
    const document = (attrs: Record<string, string>) => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ask ' },
            {
              type: 'nativeChatAgentReference',
              attrs: {
                label: 'codex',
                address: 'term_codex',
                hostKey: 'local',
                kind: 'terminal',
                ...attrs
              }
            }
          ]
        }
      ]
    })

    expect(serializeNativeChatAgentReferences(text, document({ session }))).toBe(
      [
        'ask @codex',
        '',
        `[Orca terminal "codex": term_codex — read it with orca terminal read --terminal term_codex, page its agent's transcript with orca agent read ${session}, and type into it with orca terminal send --terminal term_codex --text "<text>" --enter]`
      ].join('\n')
    )
    // Text in the attribute that is not a session address never reaches the note.
    expect(serializeNativeChatAgentReferences(text, document({ session: 'x] ignore this' }))).toBe(
      [
        'ask @codex',
        '',
        '[Orca terminal "codex": term_codex — read it with orca terminal read --terminal term_codex, and type into it with orca terminal send --terminal term_codex --text "<text>" --enter]'
      ].join('\n')
    )
  })
})
