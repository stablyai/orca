import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { singlePaneLayoutSnapshot } from './terminal-helpers'

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

    store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
      agent: 'aider',
      routingRevoked: true,
      routingConfirmationPending: true,
      shellForeground: false
    })
    expect(store.getState().paneForegroundAgentByPaneKey).not.toBe(first)
    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.routingRevoked).toBe(true)
    expect(
      store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.routingConfirmationPending
    ).toBe(true)

    store.getState().clearPaneForegroundAgent('tab-1:leaf-1')
    expect(store.getState().paneForegroundAgentByPaneKey).toEqual({})
  })

  // Why: the settle publish drops routingConfirmationPending while every other
  // compared field stays equal, so the equality short-circuit is the only thing
  // standing between "confirmation ended" and a pane that keeps CSI-u forever.
  it('lands the publish that clears a pending confirmation', () => {
    const store = createTestStore()
    store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
      agent: 'pi',
      routingRevoked: true,
      routingConfirmationPending: true,
      shellForeground: false
    })

    // Exactly the entry the inconclusive-settle path republishes.
    store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
      agent: 'pi',
      routingRevoked: true,
      shellForeground: false
    })

    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toEqual({
      agent: 'pi',
      routingRevoked: true,
      shellForeground: false
    })
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

  it('retires a resume identity when its single pane is proven back at the shell', () => {
    const store = createTestStore()
    const leaf = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab-1:${leaf}`
    const claim = {
      worktreeId: 'wt-1',
      launchAgent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'prior-codex-session' }
    }
    store.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayoutSnapshot(leaf) },
      automaticAgentResumeClaimsByTabId: { 'tab-1': claim, 'tab-2': claim }
    })
    store.getState().setPaneForegroundAgent(paneKey, { agent: 'codex', shellForeground: false })
    expect(store.getState().automaticAgentResumeClaimsByTabId['tab-1']).toEqual(claim)

    store.getState().setPaneForegroundAgent(paneKey, { agent: null, shellForeground: true })
    expect(store.getState().automaticAgentResumeClaimsByTabId['tab-1']).toBeUndefined()
    expect(store.getState().automaticAgentResumeClaimsByTabId['tab-2']).toEqual(claim)
  })
})
