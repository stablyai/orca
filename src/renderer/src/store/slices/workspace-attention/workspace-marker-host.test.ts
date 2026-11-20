import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { workspaceMarkerPaneKeysForHost } from './workspace-marker-host'

describe('a chat tab with its own id', () => {
  it('owns the markers its session address keys, so marking read clears them', () => {
    const store = createTestStore()
    seedStore(store, {
      unifiedTabsByWorktree: {
        ws: [
          {
            id: 'chat-tab-a',
            entityId: 'chat-1',
            groupId: 'g1',
            worktreeId: 'ws',
            contentType: 'agent-session',
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    const key = structuredAgentSessionPaneKey('chat-tab-a', 'chat-1')
    expect(key.startsWith('structured-agent-session-chat-1:')).toBe(true)
    expect([...workspaceMarkerPaneKeysForHost(store.getState(), 'ws', undefined, [key])]).toEqual([
      key
    ])
  })
})
