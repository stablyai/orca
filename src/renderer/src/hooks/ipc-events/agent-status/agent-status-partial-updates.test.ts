import { expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { applyProviderSessionOnlyUpdate } from './agent-status-partial-updates'

it.each([
  ['a pane-owned conversation leaves a checkpoint', false, true],
  ['a tmux-hosted conversation leaves none', true, false]
])('identity-only status of %s', (_, shared, recorded) => {
  const store = createTestStore()
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  applyProviderSessionOnlyUpdate({
    store: store.getState(),
    batch: undefined,
    data: {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agentType: 'claude',
      state: 'done',
      prompt: '',
      providerSession: { key: 'session_id', id: 'claude-session' },
      connectionId: null,
      receivedAt: 200,
      stateStartedAt: 150,
      providerSessionOnly: true,
      ...(shared ? { executionHost: 'shared' as const } : {})
    },
    paneKey,
    routing: { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null }
  })
  expect(Boolean(store.getState().sleepingAgentSessionsByPaneKey[paneKey])).toBe(recorded)
})
