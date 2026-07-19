import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { TerminalTab } from '../../../../shared/types'
import {
  PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS,
  resolveFreshPaneForegroundAgent,
  type PaneForegroundAgentEntry
} from './pane-foreground-agent'

afterEach(() => {
  vi.restoreAllMocks()
})

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
      shellForeground: false
    })
    expect(store.getState().paneForegroundAgentByPaneKey).not.toBe(first)
    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.routingRevoked).toBe(true)

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

  it('stamps observedAt when evidence is published and re-stamps past the refresh quantum', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const store = createTestStore()
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'claude',
        shellForeground: false,
        ptyId: 'pty-1'
      })
    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toEqual({
      agent: 'claude',
      shellForeground: false,
      ptyId: 'pty-1',
      observedAt: 10_000
    })
    const initial = store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']

    // Within the quantum: identical publish keeps the reference (no churn).
    nowSpy.mockReturnValue(11_000)
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'claude',
        shellForeground: false,
        ptyId: 'pty-1'
      })
    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toBe(initial)

    nowSpy.mockReturnValue(20_000)
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'claude',
        shellForeground: false,
        ptyId: 'pty-1'
      })
    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.observedAt).toBe(20_000)
  })

  it('bumps observedAt from a matching coordinator observation without touching other fields', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const store = createTestStore()
    store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
      agent: 'claude',
      shellForeground: false,
      routingTrusted: true,
      ptyId: 'pty-1'
    })

    nowSpy.mockReturnValue(20_000)
    store.getState().refreshPaneForegroundAgentObservation('tab-1:leaf-1', 'claude')

    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toEqual({
      agent: 'claude',
      shellForeground: false,
      routingTrusted: true,
      ptyId: 'pty-1',
      observedAt: 20_000
    })
  })

  it('ignores a coordinator observation whose identity differs from the tracked entry', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const store = createTestStore()
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', {
        agent: null,
        shellForeground: true,
        ptyId: 'pty-1'
      })
    const initial = store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']

    nowSpy.mockReturnValue(20_000)
    store.getState().refreshPaneForegroundAgentObservation('tab-1:leaf-1', 'claude')

    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toBe(initial)
  })

  it('creates identity-only evidence bound to the inspected PTY on a pane without an entry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const store = createTestStore()

    store.getState().refreshPaneForegroundAgentObservation('tab-1:leaf-1', 'claude', 'pty-1')

    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toEqual({
      agent: 'claude',
      shellForeground: false,
      observedAt: 10_000,
      ptyId: 'pty-1'
    })
  })

  it('rebinds evidence held for a previous PTY instead of keeping it fresh across a respawn', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const store = createTestStore()
    store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
      agent: 'claude',
      shellForeground: false,
      routingTrusted: true,
      ptyId: 'pty-old'
    })

    nowSpy.mockReturnValue(20_000)
    store.getState().refreshPaneForegroundAgentObservation('tab-1:leaf-1', 'claude', 'pty-new')

    // Why: identity-only rebind — routing trust belonged to the old PTY.
    expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toEqual({
      agent: 'claude',
      shellForeground: false,
      observedAt: 20_000,
      ptyId: 'pty-new'
    })
  })
})

describe('resolveFreshPaneForegroundAgent', () => {
  const entry = (overrides: Partial<PaneForegroundAgentEntry> = {}): PaneForegroundAgentEntry => ({
    agent: 'claude',
    shellForeground: false,
    observedAt: 10_000,
    ptyId: 'pty-1',
    ...overrides
  })

  it('returns the agent for fresh evidence bound to a live pane PTY', () => {
    expect(resolveFreshPaneForegroundAgent(entry(), { now: 10_500, paneBoundPtyId: 'pty-1' })).toBe(
      'claude'
    )
  })

  it('rejects evidence past the TTL or without an observation timestamp', () => {
    expect(
      resolveFreshPaneForegroundAgent(entry(), {
        now: 10_000 + PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS + 1,
        paneBoundPtyId: 'pty-1'
      })
    ).toBeNull()
    expect(
      resolveFreshPaneForegroundAgent(entry({ observedAt: undefined }), {
        now: 10_500,
        paneBoundPtyId: 'pty-1'
      })
    ).toBeNull()
  })

  it('rejects evidence bound to a PTY the pane no longer runs', () => {
    expect(
      resolveFreshPaneForegroundAgent(entry(), { now: 10_500, paneBoundPtyId: 'pty-2' })
    ).toBeNull()
    expect(
      resolveFreshPaneForegroundAgent(entry(), { now: 10_500, liveTabPtyIds: ['pty-2'] })
    ).toBeNull()
  })

  it('rejects evidence when the tab has no live PTY at all', () => {
    expect(
      resolveFreshPaneForegroundAgent(entry({ ptyId: undefined }), {
        now: 10_500,
        liveTabPtyIds: []
      })
    ).toBeNull()
  })

  it('falls back to tab-level liveness when no pane binding is known', () => {
    expect(
      resolveFreshPaneForegroundAgent(entry(), { now: 10_500, liveTabPtyIds: ['pty-1'] })
    ).toBe('claude')
    expect(
      resolveFreshPaneForegroundAgent(entry({ ptyId: undefined }), {
        now: 10_500,
        liveTabPtyIds: ['pty-9']
      })
    ).toBe('claude')
  })
})
