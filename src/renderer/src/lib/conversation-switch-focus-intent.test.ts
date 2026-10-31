import { beforeEach, expect, it, vi } from 'vitest'
import { recordConversationSwitchFocus } from './conversation-switch-focus-intent'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'

const store = vi.hoisted(() => ({ activeTabId: 'local-source' }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      groupsByWorktree: {
        ws: [{ id: 'group', activeTabId: store.activeTabId, tabOrder: ['local-source', 'other'] }]
      },
      activeGroupIdByWorktree: { ws: 'group' },
      unifiedTabsByWorktree: {
        ws: [
          { id: 'local-source', groupId: 'group' },
          { id: 'other', groupId: 'group' }
        ]
      }
    })
  }
}))

const remote = { kind: 'environment' as const, environmentId: 'env' }
const record = (target: Parameters<typeof recordConversationSwitchFocus>[0]['target']) =>
  recordConversationSwitchFocus({
    target,
    workspaceId: 'ws',
    sourceTabId: 'local-source',
    hostSourceTabId: 'host-source',
    chatSessionId: 'chat'
  })

beforeEach(() => {
  resetWebSessionFocusIntentForTests()
  store.activeTabId = 'local-source'
})

it('lets only a paired client still on the source follow its switch, until a refusal withdraws it', () => {
  const abandon = record(remote)
  expect(peekWebSessionFocusIntent({ environmentId: 'env' }, 'ws')).toEqual({
    hostTabId: 'agent-session:chat',
    expectedCurrentLocalTabId: 'local-source',
    afterHostTabId: 'host-source'
  })
  abandon()
  expect(peekWebSessionFocusIntent({ environmentId: 'env' }, 'ws')).toBeNull()
})

it.each([
  ['this host’s own window, which main focuses', { kind: 'local' as const }, 'local-source'],
  ['a client looking at another tab', remote, 'other']
] as const)('records nothing for %s', (_name, target, active) => {
  store.activeTabId = active
  record(target)
  expect(peekWebSessionFocusIntent(structuredAgentSessionFocusOwner(target), 'ws')).toBeNull()
})

it('selects the chat for Session History’s switch from wherever this client looks', () => {
  store.activeTabId = 'other'
  recordConversationSwitchFocus({
    target: remote,
    workspaceId: 'ws',
    sourceTabId: 'local-source',
    hostSourceTabId: 'host-source',
    chatSessionId: 'chat',
    fromHistory: true
  })
  expect(peekWebSessionFocusIntent({ environmentId: 'env' }, 'ws')).toEqual({
    hostTabId: 'agent-session:chat',
    expectedCurrentLocalTabId: 'other',
    afterHostTabId: 'host-source'
  })
})
