import { describe, expect, it, vi } from 'vitest'
import { createTabsFocusActions } from './tabs-focus-actions'

function makeState() {
  return {
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-terminal',
          contentType: 'terminal',
          entityId: 'term-1',
          groupId: 'group-1',
          isPreview: true,
          lastFocusedAt: 0
        },
        {
          id: 'tab-file',
          contentType: 'file',
          entityId: 'file-1',
          groupId: 'group-1',
          isPreview: true,
          lastFocusedAt: 0
        }
      ]
    },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          activeTabId: 'tab-file',
          tabOrder: ['tab-terminal', 'tab-file'],
          recentTabIds: []
        }
      ]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    unreadTerminalTabs: { 'term-1': true }
  }
}

describe('createTabsFocusActions.activateTab', () => {
  it('activates the matching tab, clears preview, updates MRU, and dismisses active terminal unread state', () => {
    let state = makeState()
    const set = (updater: (s: typeof state) => typeof state) => {
      state = { ...state, ...updater(state) }
    }
    const actions = createTabsFocusActions(set as never, (() => state) as never)
    actions.activateTab('tab-terminal')
    expect(state.groupsByWorktree['wt-1'][0].activeTabId).toBe('tab-terminal')
    expect(state.groupsByWorktree['wt-1'][0].recentTabIds).toEqual(['tab-terminal'])
    expect(state.unifiedTabsByWorktree['wt-1'][0].isPreview).toBe(false)
    expect(state.unreadTerminalTabs).toEqual({})
  })

  it('preserves preview when requested and leaves nonterminal unread state alone', () => {
    let state = makeState()
    const unread = state.unreadTerminalTabs
    const set = (updater: (s: typeof state) => typeof state) => {
      state = { ...state, ...updater(state) }
    }
    const actions = createTabsFocusActions(set as never, (() => state) as never)
    actions.activateTab('tab-file', { preservePreview: true })
    expect(state.unifiedTabsByWorktree['wt-1'][1].isPreview).toBe(true)
    expect(state.unreadTerminalTabs).toBe(unread)
  })

  it('selects tabs in a background workspace without activating that workspace or clearing its unread signal', () => {
    let state = { ...makeState(), activeWorktreeId: 'folder:other' }
    const unread = state.unreadTerminalTabs
    const set = (updater: (s: typeof state) => typeof state) => {
      state = { ...state, ...updater(state) }
    }
    const actions = createTabsFocusActions(set as never, (() => state) as never)
    actions.activateTab('tab-terminal')
    expect(state.groupsByWorktree['wt-1'][0].activeTabId).toBe('tab-terminal')
    expect(state.activeWorktreeId).toBe('folder:other')
    expect(state.unreadTerminalTabs).toBe(unread)
  })

  it('does not fall back to another workspace when an explicit workspace does not contain the tab', () => {
    const state = makeState()
    const set = vi.fn()
    const actions = createTabsFocusActions(set as never, (() => state) as never)
    actions.activateTab('tab-terminal', { worktreeId: 'folder:other' })
    expect(set.mock.calls[0][0](state)).toEqual({})
  })

  it('ignores unknown ids without mutating state', () => {
    const state = makeState()
    const set = vi.fn()
    const actions = createTabsFocusActions(set as never, (() => state) as never)
    actions.activateTab('missing')
    expect(set).toHaveBeenCalled()
    expect(set.mock.calls[0][0](state)).toEqual({})
  })
})
