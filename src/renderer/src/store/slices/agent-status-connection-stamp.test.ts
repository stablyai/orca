import { describe, expect, it } from 'vitest'

import { createTestStore } from './store-test-helpers'

describe('agent status connection stamps', () => {
  it('retains an accepted connection stamp across later unstamped pings', () => {
    const store = createTestStore()
    const paneKey = 'tab-a:11111111-1111-4111-8111-111111111111'
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'first', agentType: 'codex' },
        undefined,
        { updatedAt: 1 },
        { connectionId: 'ssh-a' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'ping', agentType: 'codex' },
        undefined,
        { updatedAt: 2 }
      )

    expect(store.getState().agentStatusByPaneKey[paneKey]?.connectionId).toBe('ssh-a')
  })

  it('moves a colliding pane to newer authoritative ownership', () => {
    const store = createTestStore()
    const paneKey = 'tab-a:11111111-1111-4111-8111-111111111111'
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'host a', agentType: 'codex' },
        undefined,
        { updatedAt: 1 },
        { connectionId: 'ssh-a' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'host b', agentType: 'codex' },
        undefined,
        { updatedAt: 2 },
        { connectionId: 'ssh-b' }
      )

    expect(store.getState().agentStatusByPaneKey[paneKey]).toMatchObject({
      prompt: 'host b',
      connectionId: 'ssh-b'
    })
  })
})
