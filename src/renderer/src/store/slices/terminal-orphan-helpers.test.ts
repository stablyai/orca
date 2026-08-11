import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'
import { buildTerminalTabRetirementPlan } from './terminal-tab-retirement'

// Regression coverage for #9911 ("Terminal window auto-closing. Unable to
// recover."). After hydration / SSH-relay disconnect the tab row's ptyId and
// ptyIdsByTabId are cleared, but the still-live session survives in one of the
// reconnect maps (pendingReconnectPtyIdByTabId / lastKnownRelayPtyIdByTabId /
// deferredSshSessionIdsByTabId). buildTerminalTabRetirementPlan treats those as
// live ownership; the orphan sweep must agree, or it hard-deletes a live tab
// (and its scrollback) before reconnect can rebind it.

// Why: superset state that satisfies both getOrphanTerminalIds (orphan sweep)
// and buildTerminalTabRetirementPlan (retirement authority) so one fixture can
// prove the two agree on liveness.
type TestState = Parameters<typeof buildTerminalTabRetirementPlan>[0]

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

    // The retirement authority already treats the reconnecting session as a
    // live PTY it must tear down on close…
    expect(buildTerminalTabRetirementPlan(state, 'T1').ptyIds).toContain('session-live')
    // …so the orphan sweep must not classify the same tab as dead.
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

  // A persisted layout leaf binding is NOT a liveness signal: SSH-target removal
  // nulls ptyId/ptyIdsByTabId/reconnect maps but intentionally leaves the layout
  // leaf ptyIds pointing at a relay that is gone. Such a tab must still be swept,
  // or it lingers forever bound to a dead relay it can never reattach.
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
