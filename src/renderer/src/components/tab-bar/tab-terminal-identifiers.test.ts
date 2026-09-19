import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PaneAgentSessionIdState } from '../terminal-pane/pane-agent-session-id'
import { resolveTabAgentSessionId, resolveTabIdentityLeafId } from './tab-terminal-identifiers'

const FOCUSED_LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'

/** Two-pane tab whose focus is the variable under test: `null` stands in for a tab never
 *  activated, a sibling id for a live focus, an unknown id for a stale one. */
function splitLayout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: FOCUSED_LEAF },
      second: { type: 'leaf', leafId: SIBLING_LEAF }
    },
    activeLeafId,
    expandedLeafId: null
  }
}

/** Session-resolution input with every agent-state map empty by default, so each test names only
 *  the source it exercises and an unset map cannot silently supply a session. */
function sessionArgs(overrides: {
  layout?: TerminalLayoutSnapshot
  agentStatusByPaneKey?: Record<string, unknown>
  sleepingAgentSessionsByPaneKey?: Record<string, unknown>
  paneForegroundAgentByPaneKey?: Record<string, unknown>
}): Parameters<typeof resolveTabAgentSessionId>[0] {
  return {
    tabId: 'term-1',
    layout: overrides.layout,
    state: {
      agentStatusByPaneKey: overrides.agentStatusByPaneKey ?? {},
      sleepingAgentSessionsByPaneKey: overrides.sleepingAgentSessionsByPaneKey ?? {},
      paneForegroundAgentByPaneKey: overrides.paneForegroundAgentByPaneKey ?? {}
    } as PaneAgentSessionIdState
  }
}

describe('resolveTabIdentityLeafId', () => {
  it('prefers the focused pane of a split tab', () => {
    expect(resolveTabIdentityLeafId(splitLayout(SIBLING_LEAF))).toBe(SIBLING_LEAF)
  })

  it('falls back to the first pane when focus is missing or stale', () => {
    expect(resolveTabIdentityLeafId(splitLayout(null))).toBe(FOCUSED_LEAF)
    expect(resolveTabIdentityLeafId(splitLayout('33333333-3333-4333-8333-333333333333'))).toBe(
      FOCUSED_LEAF
    )
  })

  it('keeps a persisted focus for a tab whose layout has no tree yet', () => {
    expect(
      resolveTabIdentityLeafId({ root: null, activeLeafId: FOCUSED_LEAF, expandedLeafId: null })
    ).toBe(FOCUSED_LEAF)
    expect(resolveTabIdentityLeafId(undefined)).toBeNull()
  })

  // Why: once a tree exists, a leaf missing from it has been removed. Honouring it would hand a
  // dead pane key to copyTerminalHandleForPane and to the session lookup.
  it('rejects a stale focus once the tree holds no terminal leaf', () => {
    expect(
      resolveTabIdentityLeafId({
        root: { type: 'leaf', leafId: 'not-a-stable-pane-id' },
        activeLeafId: FOCUSED_LEAF,
        expandedLeafId: null
      })
    ).toBeNull()
  })

  it('binds a rootless tab to its single pty when no focus was persisted', () => {
    expect(
      resolveTabIdentityLeafId({
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [FOCUSED_LEAF]: 'pty-1' }
      })
    ).toBe(FOCUSED_LEAF)
  })
})

describe('resolveTabAgentSessionId', () => {
  // Why: #18070 moved the pane-level copy off the tab menu because resolving to the tab's active
  // pane silently picks one of several agents. Offering nothing keeps the tab menu unambiguous;
  // a split tab is copied from each pane's own menu.
  it('offers nothing when two panes own different sessions', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: splitLayout(SIBLING_LEAF),
          agentStatusByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'first' } },
            [`term-1:${SIBLING_LEAF}`]: { providerSession: { key: 'session_id', id: 'second' } }
          }
        })
      )
    ).toBeNull()
  })

  it('still resolves when both panes report the same session', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: splitLayout(SIBLING_LEAF),
          agentStatusByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'shared' } },
            [`term-1:${SIBLING_LEAF}`]: { providerSession: { key: 'session_id', id: 'shared' } }
          }
        })
      )
    ).toBe('shared')
  })

  it('resolves a lone session owned by an unfocused pane', () => {
    const sessionId = resolveTabAgentSessionId(
      sessionArgs({
        layout: splitLayout(FOCUSED_LEAF),
        agentStatusByPaneKey: {
          [`term-1:${SIBLING_LEAF}`]: { providerSession: { key: 'session_id', id: 'sibling' } }
        }
      })
    )

    expect(sessionId).toBe('sibling')
  })

  // Why: Copy Terminal ID resolves a rootless restored tab via the identity leaf, so Copy Session
  // ID must see the same pane rather than reporting the tab has none.
  it('resolves the session of a rootless restored tab', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: { root: null, activeLeafId: FOCUSED_LEAF, expandedLeafId: null },
          agentStatusByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'restored' } }
          }
        })
      )
    ).toBe('restored')
  })

  it('keeps a slept agent copyable', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: splitLayout(FOCUSED_LEAF),
          sleepingAgentSessionsByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'slept' } }
          }
        })
      )
    ).toBe('slept')
  })

  // Why: the pane menu hides its own Copy Session ID for these two states, so the tab menu that
  // delegates to the same resolver must hide it too rather than copy an unresumable id.
  it('reports no session once the pane is back at the shell', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: splitLayout(FOCUSED_LEAF),
          agentStatusByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'exited' } }
          },
          paneForegroundAgentByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { shellForeground: true }
          }
        })
      )
    ).toBeNull()
  })

  it('ignores an unconfirmed restored entry and prefers the durable record', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: splitLayout(FOCUSED_LEAF),
          agentStatusByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: {
              restoredUnconfirmed: true,
              providerSession: { key: 'session_id', id: 'unconfirmed' }
            }
          },
          sleepingAgentSessionsByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'durable' } }
          }
        })
      )
    ).toBe('durable')
  })

  it('reports no session for a plain shell tab', () => {
    expect(resolveTabAgentSessionId(sessionArgs({ layout: splitLayout(FOCUSED_LEAF) }))).toBeNull()
  })
})
