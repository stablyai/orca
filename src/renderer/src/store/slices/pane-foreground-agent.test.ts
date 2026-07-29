import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { TerminalTab } from '../../../../shared/types'

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('pane foreground agent slice', () => {
  it('sets, value-bails, and clears entries per pane key', () => {
    const store = createTestStore()
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
    const first = store.getState().paneForegroundAgentByPaneKey

    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
    expect(store.getState().paneForegroundAgentByPaneKey).toBe(first)

    store.getState().clearPaneForegroundAgent('tab-1:leaf-1')
    expect(store.getState().paneForegroundAgentByPaneKey).toEqual({})
  })

  it('sweeps only the closed tab prefix, not sibling tabs or prefix-share ids', () => {
    const store = createTestStore()
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
    store
      .getState()
      .setPaneForegroundAgent('tab-10:leaf-1', { agent: 'codex', shellForeground: false })

    store.getState().clearPaneForegroundAgentByTabPrefix('tab-1')

    expect(Object.keys(store.getState().paneForegroundAgentByPaneKey)).toEqual(['tab-10:leaf-1'])
  })

  it('sweeps every tab of a worktree on wholesale teardown', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [terminalTab('tab-1', 'wt-1'), terminalTab('tab-2', 'wt-1')],
        'wt-2': [terminalTab('tab-3', 'wt-2')]
      }
    })
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
    store.getState().setPaneForegroundAgent('tab-2:leaf-1', { agent: null, shellForeground: true })
    store
      .getState()
      .setPaneForegroundAgent('tab-3:leaf-1', { agent: 'codex', shellForeground: false })

    const before = store.getState().paneForegroundAgentByPaneKey
    store.getState().clearPaneForegroundAgentByWorktree('wt-missing')
    expect(store.getState().paneForegroundAgentByPaneKey).toBe(before)

    store.getState().clearPaneForegroundAgentByWorktree('wt-1')

    expect(Object.keys(store.getState().paneForegroundAgentByPaneKey)).toEqual(['tab-3:leaf-1'])
  })
})
