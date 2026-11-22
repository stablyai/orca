import { describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../journal/agent-session-journal-types'
import type { AgentMessageSource } from '../journal/agent-session-message-source'
import { projectStructuredItemToNativeChat } from '../view/structured-agent-session-projection'

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
      name: 'Coder'
    }
  ],
  orchestration: null
}

function message(role: 'user' | 'assistant', from?: unknown): AgentJournalRenderItem {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role,
    blocks: [{ type: 'text', text: 'hi' }]
  }
  return {
    itemId: `orca:submission:${role}`,
    sequence: 1,
    revision: 0,
    observedAt: 1,
    // A body as a client receives it: off the wire, from a host of any version.
    body: from === undefined ? body : Object.assign(body, { from: structuredClone(from) })
  }
}

describe("a message's sender, projected for every client", () => {
  it("leaves the person's message, and a value no reader can place, without one", () => {
    expect(projectStructuredItemToNativeChat(message('user'))).not.toHaveProperty('from')
    expect(projectStructuredItemToNativeChat(message('user', 'nobody'))).not.toHaveProperty('from')
    expect(projectStructuredItemToNativeChat(message('assistant', FROM))).not.toHaveProperty('from')
  })
})

describe("a connector message's asker, projected for every client", () => {
  const ASKER = {
    source: 'slack',
    userId: 'U0SAM',
    name: 'Sam Lee',
    role: 'member',
    place: { kind: 'public_channel', id: 'C9' }
  } as const

  function delivered(
    role: 'user' | 'assistant',
    fields: Record<string, unknown>
  ): AgentJournalRenderItem {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role,
      blocks: [{ type: 'text', text: 'review #42' }]
    }
    return {
      itemId: `orca:submission:${role}`,
      sequence: 1,
      revision: 0,
      observedAt: 1,
      body: Object.assign(body, structuredClone(fields))
    }
  }

  it('tags a message the host marked as a connector delivery', () => {
    const projected = projectStructuredItemToNativeChat(
      delivered('user', { origin: 'connector', asker: ASKER })
    )
    expect(projected?.asker).toEqual(ASKER)
  })

  it("marks Orca's first turn to a new bot as a notice", () => {
    expect(
      projectStructuredItemToNativeChat(delivered('user', { origin: 'bot-created' }))?.orcaNotice
    ).toBe('bot-created')
    expect(
      projectStructuredItemToNativeChat(delivered('assistant', { origin: 'bot-created' }))
    ).not.toHaveProperty('orcaNotice')
  })

  it('leaves an unmarked, unreadable or assistant-row asker untagged', () => {
    for (const item of [
      delivered('user', { asker: ASKER }),
      delivered('user', { origin: 'connector', asker: { ...ASKER, role: 'admin' } }),
      delivered('assistant', { origin: 'connector', asker: ASKER })
    ]) {
      expect(projectStructuredItemToNativeChat(item)).not.toHaveProperty('asker')
    }
  })
})
