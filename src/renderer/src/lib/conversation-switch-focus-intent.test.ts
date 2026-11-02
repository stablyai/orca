import { beforeEach, expect, it, vi } from 'vitest'
import { recordConversationSwitchFocus } from './conversation-switch-focus-intent'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'

const store = vi.hoisted(() => ({ activeTabId: 'local-tab', split: true }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      groupsByWorktree: {
        ws: [{ id: 'group', activeTabId: store.activeTabId, tabOrder: ['local-tab', 'other'] }]
      },
      activeGroupIdByWorktree: { ws: 'group' },
      unifiedTabsByWorktree: {
        ws: [
          // A host switch earlier left this terminal in a tab with another id.
          { id: 'local-tab', entityId: 'local-source', contentType: 'terminal', groupId: 'group' },
          { id: 'other', entityId: 'other', groupId: 'group' }
        ]
      },
      terminalLayoutsByTabId: {
        'local-source': {
          root: store.split
            ? {
                type: 'split',
                direction: 'vertical',
                first: { type: 'leaf', leafId: 'a' },
                second: { type: 'leaf', leafId: 'b' }
              }
            : { type: 'leaf', leafId: 'a' }
        }
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
  store.activeTabId = 'local-tab'
  store.split = true
})

it('lets only a paired client still on a split source follow its switch, until a refusal withdraws it', () => {
  const abandon = record(remote)
  expect(peekWebSessionFocusIntent({ environmentId: 'env' }, 'ws')).toEqual({
    hostTabId: 'agent-session:chat',
    expectedCurrentLocalTabId: 'local-tab',
    afterHostTabId: 'host-source'
  })
  abandon()
  expect(peekWebSessionFocusIntent({ environmentId: 'env' }, 'ws')).toBeNull()
})

it.each([
  ['this host’s own window, which main focuses', { kind: 'local' as const }, 'local-tab', true],
  ['a client looking at another tab', remote, 'other', true],
  // The same tab takes the chat, so its selection already stays.
  ['a whole tab', remote, 'local-tab', false]
] as const)('records nothing for %s', (_name, target, active, split) => {
  store.activeTabId = active
  store.split = split
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
