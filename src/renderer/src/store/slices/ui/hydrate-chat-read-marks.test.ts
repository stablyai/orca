import { expect, it, vi } from 'vitest'
import { chatPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

it('caps desktop acknowledgements at hydration when a saved alias has no matching chat', () => {
  vi.stubGlobal('window', undefined)
  try {
    const alias = `agent-chat-tab-v1-abc:${chatPaneKey('closed-chat').split(':').at(-1)}`
    const acknowledgements: Record<string, number> = { [alias]: 501 }
    for (let index = 1; index <= 500; index++) {
      acknowledgements[`terminal-${index}:pane`] = index
    }
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ acknowledgedAgentsByPaneKey: acknowledgements }),
        'startup'
      )

    const hydrated = store.getState().acknowledgedAgentsByPaneKey
    expect(Object.keys(hydrated)).toHaveLength(500)
    expect(hydrated['terminal-1:pane']).toBeUndefined()
    expect(hydrated[alias]).toBe(501)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('retains a live chat cleared-at cutoff across hydration even after 500 newer clears', () => {
  vi.stubGlobal('window', undefined)
  try {
    const liveChat = chatPaneKey('live-chat')
    const cleared: Record<string, number> = { [liveChat]: 1 }
    for (let index = 1; index <= 500; index++) {
      cleared[`terminal-${index}:pane`] = index + 10
    }
    const store = createUIStore()
    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            entityId: 'live-chat',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'agent-session',
            agentSessionAgent: 'claude',
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ activityClearedAtByPaneKey: cleared }), 'startup')

    const hydrated = store.getState().activityClearedAtByPaneKey
    expect(hydrated[liveChat]).toBe(1)
    expect(Object.keys(hydrated)).toHaveLength(500)
  } finally {
    vi.unstubAllGlobals()
  }
})
