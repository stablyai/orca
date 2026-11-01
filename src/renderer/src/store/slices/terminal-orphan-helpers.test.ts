import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'
import { buildTerminalTabRetirementPlan } from './terminal-tab-retirement'

// Reconnect-map sessions count as retirement ownership and must also prevent orphan deletion before rebind (#9911).

// Use one state fixture to prove retirement and orphan sweep agree on liveness.
type TestState = Parameters<typeof buildTerminalTabRetirementPlan>[0] &
  Parameters<typeof getOrphanTerminalIds>[0]

function makeTab(overrides: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeState(overrides: Partial<TestState> = {}): TestState {
  return {
    worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo', hostId: 'local' }] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    unverifiedPtyLossTabIds: {},
    ...overrides
  } as TestState
}

describe('getOrphanTerminalIds reconnect-map liveness', () => {
  it('does not orphan a tab whose live session survives in pendingReconnectPtyIdByTabId', () => {
    const state = makeState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'T1', ptyId: null })] },
      ptyIdsByTabId: { T1: [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      pendingReconnectPtyIdByTabId: { T1: 'session-live' }
    })

    expect(buildTerminalTabRetirementPlan(state, 'T1').ptyIds).toContain('session-live')
    expect(getOrphanTerminalIds(state, 'wt-1')).not.toContain('T1')
  })

  it('does not orphan a tab whose live session survives in lastKnownRelayPtyIdByTabId', () => {
    const state = makeState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'T1' })] },
      ptyIdsByTabId: { T1: [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      lastKnownRelayPtyIdByTabId: { T1: 'relay:conn@@pty-live' }
    })

    expect(getOrphanTerminalIds(state, 'wt-1')).not.toContain('T1')
  })

  it('does not orphan a tab whose live session survives in deferredSshSessionIdsByTabId', () => {
    const state = makeState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'T1' })] },
      ptyIdsByTabId: { T1: [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      deferredSshSessionIdsByTabId: { T1: 'ssh-session-live' }
    })

    expect(getOrphanTerminalIds(state, 'wt-1')).not.toContain('T1')
  })

  it('still orphans a tab with no live PTY evidence anywhere', () => {
    const state = makeState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'dead', ptyId: null })] },
      ptyIdsByTabId: { dead: [] },
      unifiedTabsByWorktree: { 'wt-1': [] }
    })

    expect(getOrphanTerminalIds(state, 'wt-1')).toContain('dead')
  })

  it('does not orphan a tab whose PTY loss is unverified', () => {
    const state = makeState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'host-lost', ptyId: null })] },
      ptyIdsByTabId: { 'host-lost': [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      unverifiedPtyLossTabIds: { 'host-lost': true }
    })

    expect(getOrphanTerminalIds(state, 'wt-1')).not.toContain('host-lost')
  })

  // SSH removal leaves persisted layout bindings behind; these cannot prove liveness or dead relay tabs stay forever.
  it('still orphans a tab whose only reference is a stale layout leaf binding', () => {
    const state = makeState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'stale-layout', ptyId: null })] },
      ptyIdsByTabId: { 'stale-layout': [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      terminalLayoutsByTabId: {
        'stale-layout': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'dead-relay-pty' }
        }
      }
    })

    expect(getOrphanTerminalIds(state, 'wt-1')).toContain('stale-layout')
  })
})
