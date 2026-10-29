import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

describe('pane foreground peer metadata', () => {
  it('updates metadata for the same agent and clears it when the pane returns to a shell', () => {
    const store = createTestStore()
    const entry = {
      agent: 'claude',
      shellForeground: false,
      agentName: 'Amber Harbor',
      agentPid: 123,
      permissionMode: 'default'
    } as const
    store.getState().setPaneForegroundAgent('tab:leaf', entry)
    store.getState().setPaneForegroundAgent('tab:leaf', {
      ...entry,
      agentName: 'Quiet Forest',
      agentPid: 456,
      permissionMode: 'plan'
    })
    expect(store.getState().paneForegroundAgentByPaneKey['tab:leaf']).toMatchObject({
      agentName: 'Quiet Forest',
      agentPid: 456,
      permissionMode: 'plan'
    })
    store.getState().setPaneForegroundAgent('tab:leaf', { agent: null, shellForeground: true })
    expect(store.getState().paneForegroundAgentByPaneKey['tab:leaf']?.agentName).toBeUndefined()
  })
})
