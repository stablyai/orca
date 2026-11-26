import { expect, it } from 'vitest'
import { findTabByIdOrChatAlias } from './structured-agent-session-tab'

it('prefers a chat session over a rebound tab with its legacy-derived id', () => {
  const tabs = [
    { id: 'structured-agent-session-A', contentType: 'agent-session', entityId: 'B' },
    { id: 'agent-chat-tab-v1-reopened', contentType: 'agent-session', entityId: 'A' }
  ]

  expect(findTabByIdOrChatAlias(tabs, 'structured-agent-session-A')).toBe(tabs[1])
})
