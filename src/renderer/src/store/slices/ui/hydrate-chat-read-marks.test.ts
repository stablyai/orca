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
