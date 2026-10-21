import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem, AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentMessageSource } from './agent-session-message-source'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

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
  it('carries the sender of a user-role message another agent sent', () => {
    expect(projectStructuredItemToNativeChat(message('user', FROM))?.from).toEqual(FROM)
  })

  it("leaves the person's message, and a value no reader can place, without one", () => {
    expect(projectStructuredItemToNativeChat(message('user'))).not.toHaveProperty('from')
    expect(projectStructuredItemToNativeChat(message('user', 'nobody'))).not.toHaveProperty('from')
    expect(projectStructuredItemToNativeChat(message('assistant', FROM))).not.toHaveProperty('from')
  })
})
