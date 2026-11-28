import { expect, it } from 'vitest'
import { chatPaneKey } from './structured-agent-session-projection'
import { findTabByChatPaneKey, findTabByIdOrChatAlias } from './structured-agent-session-tab'

it('resolves a real tab id before a legacy chat alias', () => {
  const tabs = [
    { id: 'structured-agent-session-A', contentType: 'agent-session', entityId: 'B' },
    { id: 'agent-chat-tab-v1-reopened', contentType: 'agent-session', entityId: 'A' }
  ]

  expect(findTabByIdOrChatAlias(tabs, 'structured-agent-session-A')).toBe(tabs[0])
})

it('resolves a chat pane key by its conversation', () => {
  const tabs = [
    { id: 'structured-agent-session-A', contentType: 'agent-session', entityId: 'B' },
    { id: 'agent-chat-tab-v1-reopened', contentType: 'agent-session', entityId: 'A' }
  ]

  expect(findTabByChatPaneKey(tabs, chatPaneKey('A'))).toBe(tabs[1])
})
