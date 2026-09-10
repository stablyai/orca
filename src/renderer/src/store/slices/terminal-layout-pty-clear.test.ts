import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'

// D1/D2 stale-record fix (wave 10): killPtyBeforeOmpRpcAcquire clears both
// the tab-level ptyId (clearTabPtyId, pre-existing) and the layout leaf's
// ptyId (clearTerminalLayoutPanePtyId, new this wave) so a pane whose RPC
// acquire subsequently fails never advertises a leaf pty id whose process
// is already gone.
describe('clearTerminalLayoutPanePtyId', () => {
  it('deletes the leaf entry when it still matches the killed ptyId', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const ptyId = 'pty-killed'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': ptyId }
        }
      }
    })

    store.getState().clearTerminalLayoutPanePtyId('tab-1', 'leaf-1', ptyId)

    expect(store.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toBeUndefined()
  })

  it('preserves sibling leaf bindings in a split', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const ptyId = 'pty-killed'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': ptyId, 'leaf-2': 'pty-sibling' }
        }
      }
    })

    store.getState().clearTerminalLayoutPanePtyId('tab-1', 'leaf-1', ptyId)

    expect(store.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      'leaf-2': 'pty-sibling'
    })
  })

  it('never clobbers a newer binding a race already wrote for the same leaf', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const staleKilledPtyId = 'pty-killed'
    const newerPtyId = 'pty-newer'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: newerPtyId })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': newerPtyId }
        }
      }
    })

    // A stale caller closing over the id it killed must not delete a leaf
    // binding that already moved on to a different pty.
    store.getState().clearTerminalLayoutPanePtyId('tab-1', 'leaf-1', staleKilledPtyId)

    expect(store.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      'leaf-1': newerPtyId
    })
  })

  it('is a no-op when the tab has no layout yet', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-1' })]
      }
    })

    expect(() =>
      store.getState().clearTerminalLayoutPanePtyId('tab-1', 'leaf-1', 'pty-1')
    ).not.toThrow()
    expect(store.getState().terminalLayoutsByTabId['tab-1']).toBeUndefined()
  })
})
