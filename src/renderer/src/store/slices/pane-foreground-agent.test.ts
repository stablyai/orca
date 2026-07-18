import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { TerminalTab } from '../../../../shared/types'
import { resolveAgentShiftEnterEncodingForPane } from '../../components/terminal-pane/terminal-windows-shift-enter'

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

  it('updates a remote exit tombstone for each new launch generation', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-1'
    const launchConfig = { agentArgs: '', agentEnv: {} }

    vi.setSystemTime(10)
    store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: 'launch-10'
    })
    const generation10 = store.getState().agentLaunchConfigByPaneKey[paneKey]!.registeredAt
    store.getState().setPaneForegroundAgent(paneKey, {
      agent: 'codex',
      routingTrusted: false,
      blockedLaunchRegisteredAt: generation10,
      shellForeground: false
    })
    expect(resolveAgentShiftEnterEncodingForPane(store.getState(), paneKey, true)).toBeNull()

    vi.setSystemTime(10)
    store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: 'launch-11'
    })
    const generation11 = store.getState().agentLaunchConfigByPaneKey[paneKey]!.registeredAt
    expect(generation11).toBeGreaterThan(generation10)
    expect(resolveAgentShiftEnterEncodingForPane(store.getState(), paneKey, true)).toBe('ctrl-j')

    store.getState().setPaneForegroundAgent(paneKey, {
      agent: 'codex',
      routingTrusted: false,
      blockedLaunchRegisteredAt: generation11,
      shellForeground: false
    })
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.blockedLaunchRegisteredAt).toBe(
      generation11
    )
    expect(resolveAgentShiftEnterEncodingForPane(store.getState(), paneKey, true)).toBeNull()
    vi.useRealTimers()
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
