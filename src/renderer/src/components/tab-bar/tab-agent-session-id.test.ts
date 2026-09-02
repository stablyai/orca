import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resolveTabAgentSessionId, type TabAgentSessionIdState } from './tab-agent-session-id'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: `tab-1:${LEAF_A}`,
    agentType: 'claude',
    stateHistory: [],
    ...overrides
  }
}

function state(overrides: Partial<TabAgentSessionIdState> = {}): TabAgentSessionIdState {
  return {
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_A },
        activeLeafId: LEAF_A,
        expandedLeafId: null
      }
    },
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    ...overrides
  }
}

describe('resolveTabAgentSessionId', () => {
  it('is absent when the pane has no agent row', () => {
    expect(resolveTabAgentSessionId(state(), 'tab-1')).toBeNull()
  })

  it('is absent for a tab with no layout', () => {
    expect(resolveTabAgentSessionId(state(), 'tab-missing')).toBeNull()
  })

  it('reads the id reported by the active pane', () => {
    const resolved = resolveTabAgentSessionId(
      state({
        agentStatusByPaneKey: {
          [`tab-1:${LEAF_A}`]: entry({ providerSession: { key: 'session_id', id: 'abc-123' } })
        }
      }),
      'tab-1'
    )
    expect(resolved).toBe('abc-123')
  })

  it('is absent until the agent reports an id', () => {
    const resolved = resolveTabAgentSessionId(
      state({ agentStatusByPaneKey: { [`tab-1:${LEAF_A}`]: entry() } }),
      'tab-1'
    )
    expect(resolved).toBeNull()
  })

  describe('liveness', () => {
    it('is absent for a hydrated row with no live hook since restore', () => {
      const resolved = resolveTabAgentSessionId(
        state({
          agentStatusByPaneKey: {
            [`tab-1:${LEAF_A}`]: entry({
              restoredUnconfirmed: true,
              providerSession: { key: 'session_id', id: 'abc-123' }
            })
          }
        }),
        'tab-1'
      )
      expect(resolved).toBeNull()
    })

    it('is absent once the pane is proven back at the shell', () => {
      const resolved = resolveTabAgentSessionId(
        state({
          agentStatusByPaneKey: {
            [`tab-1:${LEAF_A}`]: entry({ providerSession: { key: 'session_id', id: 'abc-123' } })
          },
          paneForegroundAgentByPaneKey: {
            [`tab-1:${LEAF_A}`]: { agent: null, shellForeground: true }
          }
        }),
        'tab-1'
      )
      expect(resolved).toBeNull()
    })

    it('keeps a session whose foreground evidence is only that an agent runs', () => {
      const resolved = resolveTabAgentSessionId(
        state({
          agentStatusByPaneKey: {
            [`tab-1:${LEAF_A}`]: entry({ providerSession: { key: 'session_id', id: 'abc-123' } })
          },
          paneForegroundAgentByPaneKey: {
            [`tab-1:${LEAF_A}`]: { agent: 'claude', shellForeground: false }
          }
        }),
        'tab-1'
      )
      expect(resolved).toBe('abc-123')
    })

    it('keeps a working session that reported a session boundary', () => {
      // Why: sessionBoundary marks a resume/clear landing idle — a session start,
      // not a session end, and exactly when the first id arrives.
      const resolved = resolveTabAgentSessionId(
        state({
          agentStatusByPaneKey: {
            [`tab-1:${LEAF_A}`]: entry({
              sessionBoundary: true,
              providerSession: { key: 'session_id', id: 'fresh-1' }
            })
          }
        }),
        'tab-1'
      )
      expect(resolved).toBe('fresh-1')
    })
  })

  describe('split tabs', () => {
    const splitState = (activeLeafId: string): TabAgentSessionIdState =>
      state({
        terminalLayoutsByTabId: {
          'tab-1': {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: LEAF_A },
              second: { type: 'leaf', leafId: LEAF_B }
            },
            activeLeafId,
            expandedLeafId: null
          }
        },
        agentStatusByPaneKey: {
          [`tab-1:${LEAF_A}`]: entry({ providerSession: { key: 'session_id', id: 'left' } }),
          [`tab-1:${LEAF_B}`]: entry({ providerSession: { key: 'session_id', id: 'right' } })
        }
      })

    it('reads the active pane, not a sibling', () => {
      expect(resolveTabAgentSessionId(splitState(LEAF_B), 'tab-1')).toBe('right')
    })

    it('is absent when the active leaf id no longer exists in the layout', () => {
      const stale = '33333333-3333-4333-8333-333333333333'
      expect(resolveTabAgentSessionId(splitState(stale), 'tab-1')).toBeNull()
    })
  })
})
