import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

describe('pane command identity store', () => {
  it('rejects duplicate or older epochs for the same PTY', () => {
    const store = createTestStore()
    store.getState().setPaneCommandIdentity('pane-1', {
      ptyId: 'pty-1',
      commandEpoch: 2,
      startSeq: 20,
      agent: 'codex',
      trusted: true
    })
    store.getState().setPaneCommandIdentity('pane-1', {
      ptyId: 'pty-1',
      commandEpoch: 2,
      startSeq: 30,
      agent: 'claude',
      trusted: false
    })

    expect(store.getState().paneCommandIdentityByPaneKey['pane-1']).toMatchObject({
      commandEpoch: 2,
      startSeq: 20,
      agent: 'codex'
    })
  })

  it('accepts epoch one for a replacement PTY and clears only matching PTYs', () => {
    const store = createTestStore()
    store.getState().setPaneCommandIdentity('pane-1', {
      ptyId: 'pty-old',
      commandEpoch: 7,
      startSeq: 70,
      agent: 'codex',
      trusted: true
    })
    store.getState().setPaneCommandIdentity('pane-1', {
      ptyId: 'pty-new',
      commandEpoch: 1,
      startSeq: 1,
      agent: 'claude',
      trusted: true
    })
    store.getState().clearPaneCommandIdentity('pane-1', 'pty-old')
    expect(store.getState().paneCommandIdentityByPaneKey['pane-1']?.ptyId).toBe('pty-new')

    store.getState().clearPaneCommandIdentity('pane-1', 'pty-new')
    expect(store.getState().paneCommandIdentityByPaneKey['pane-1']).toBeUndefined()
  })
})
