import { describe, expect, it } from 'vitest'
import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
import { createTestStore, makeTab } from '../store/slices/store-test-helpers'

describe('selected grid workspace identity', () => {
  it('keeps the clicked workspace when the sidebar owns a duplicate tab ID', () => {
    const store = createTestStore()
    store.setState({
      activeView: 'sessions',
      activeWorktreeId: 'wt-sidebar',
      activeSessionGridTabId: 'tab-1',
      tabsByWorktree: {
        'wt-sidebar': [makeTab({ id: 'tab-1', worktreeId: 'wt-sidebar' })],
        'wt-card': [makeTab({ id: 'tab-1', worktreeId: 'wt-card' })]
      }
    })
    store.getState().setActiveSessionGridTabId('tab-1', 'wt-card')
    const state = store.getState()
    expect(resolveAutoAckTabTargets(state, { floatingPanelVisible: false })).toEqual([
      { tabId: 'tab-1', worktreeId: 'wt-card', surfaceKind: 'terminal' }
    ])
    expect(
      resolveAutoAckTabTargets(
        {
          ...state,
          tabsByWorktree: {
            'wt-sidebar': state.tabsByWorktree['wt-sidebar']
          }
        },
        { floatingPanelVisible: false }
      )
    ).toEqual([])
  })
})
