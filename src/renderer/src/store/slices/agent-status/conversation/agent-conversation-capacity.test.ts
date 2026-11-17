import { expect, it } from 'vitest'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { replaceRecordEntries } from '../../../record-transitions/keyed-record-transitions'

import type { AgentPaneConversationIdentity } from './agent-pane-conversation'

function conversation(key: string): AgentPaneConversationIdentity {
  return {
    paneKey: key,
    worktreeId: 'wt-order',
    executionHostId: 'local',
    connectionId: null,
    agent: 'codex'
  }
}

it('appends a new integer-shaped key for eviction, then follows record ordering on later writes', () => {
  const store = createTestStore()
  const keys = Array.from({ length: 500 }, (_, i) => `gone-${i}:leaf`)
  store.setState({
    agentConversationsByPaneKey: Object.fromEntries(keys.map((key) => [key, conversation(key)]))
  })
  store.setState((state) => ({
    agentConversationsByPaneKey: replaceRecordEntries(state.agentConversationsByPaneKey, [
      ['1', conversation('1')]
    ])
  }))
  expect(store.getState().agentConversationsByPaneKey['gone-0:leaf']).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey['1']).toBeDefined()
  store.setState((state) => ({
    agentConversationsByPaneKey: replaceRecordEntries(state.agentConversationsByPaneKey, [
      ['last:leaf', conversation('last:leaf')]
    ])
  }))
  expect(store.getState().agentConversationsByPaneKey['1']).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey['gone-1:leaf']).toBeDefined()
})
