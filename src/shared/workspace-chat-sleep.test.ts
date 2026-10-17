import { expect, it } from 'vitest'
import type { Tab } from './tab-types'
import { withoutReplacedSleptChats } from './workspace-chat-sleep'

it('retires only a replaced host chat and keeps absent disconnected chats', () => {
  const workspace = 'repo::/same'
  const intents = {
    [`runtime:a|${workspace}`]: [{ tabId: 'same', sessionId: 'old' }],
    [`runtime:b|${workspace}`]: [{ tabId: 'same', sessionId: 'other' }],
    [`runtime:c|${workspace}`]: [{ tabId: 'absent', sessionId: 'offline' }]
  }
  const replacement: Tab = {
    id: 'same',
    entityId: 'new',
    executionHostId: 'runtime:a',
    worktreeId: workspace,
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }

  expect(withoutReplacedSleptChats(intents, { [workspace]: [replacement] }, workspace)).toEqual({
    [`runtime:b|${workspace}`]: intents[`runtime:b|${workspace}`],
    [`runtime:c|${workspace}`]: intents[`runtime:c|${workspace}`]
  })
})
