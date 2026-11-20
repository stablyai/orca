import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPaneKey } from './structured-agent-session-projection'
import { findTabByIdOrChatAlias } from './structured-agent-session-tab'

const minted = { id: 'chat-tab-5b1e', contentType: 'agent-session', entityId: 'chat-1' }
const legacy = {
  id: 'structured-agent-session-chat-2',
  contentType: 'agent-session',
  entityId: 'chat-2'
}
const terminal = { id: 'term-1', contentType: 'terminal', entityId: 'term-1' }

describe('a minted chat tab', () => {
  it('keeps the pane address its chat had, so saved status and worker links still reach it', () => {
    expect(structuredAgentSessionPaneKey(minted.id, 'chat-1')).toBe(
      structuredAgentSessionPaneKey('structured-agent-session-chat-1', 'chat-1')
    )
  })

  it('answers to the legacy and host ids older callers and peers derive from its chat', () => {
    const tabs = [terminal, legacy, minted]
    expect(findTabByIdOrChatAlias(tabs, 'structured-agent-session-chat-1')).toBe(minted)
    expect(findTabByIdOrChatAlias(tabs, 'agent-session:chat-1')).toBe(minted)
    expect(findTabByIdOrChatAlias(tabs, 'structured-agent-session-chat-2')).toBe(legacy)
    expect(findTabByIdOrChatAlias(tabs, 'agent-session:term-1')).toBeUndefined()
  })
})
