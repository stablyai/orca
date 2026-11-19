import { describe, expect, it } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'

describe('manual pane restart queue', () => {
  it('lets an account restart win over a queued manual restart of the same pane', () => {
    const store = createTestStore()
    store.getState().queuePaneManualRestarts([{ ptyId: 'pty-1', agent: 'gemini' }])
    store.getState().queuePaneAccountRestarts(['pty-1'], 'claude')

    expect(store.getState().consumePendingPaneRestart('pty-1')).toEqual({
      agent: 'claude',
      intent: 'account'
    })
    expect(store.getState().pendingPaneManualRestarts).toEqual({})
  })

  it('consumes and drops manual entries', () => {
    const store = createTestStore()
    store.getState().queuePaneManualRestarts([
      { ptyId: 'pty-1', agent: 'gemini' },
      { ptyId: 'pty-2', agent: 'codex' }
    ])

    expect(store.getState().consumePendingPaneRestart('pty-1')).toEqual({
      agent: 'gemini',
      intent: 'manual'
    })
    store.getState().dropPendingPaneManualRestart('pty-2')
    expect(store.getState().pendingPaneManualRestarts).toEqual({})
    expect(store.getState().consumePendingPaneRestart('pty-1')).toBeNull()
  })
})
