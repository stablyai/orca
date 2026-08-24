import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { resolveTabAgentSessionId, resolveTabIdentityLeafId } from './tab-terminal-identifiers'

const FOCUSED_LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'

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

function sessionArgs(overrides: {
  layout?: TerminalLayoutSnapshot
  agentStatusByPaneKey?: Record<string, Partial<AgentStatusEntry>>
  retainedAgentsByPaneKey?: Record<string, { entry: Partial<AgentStatusEntry> }>
  sleepingAgentSessionsByPaneKey?: Record<string, Partial<SleepingAgentSessionRecord>>
}): Parameters<typeof resolveTabAgentSessionId>[0] {
  return {
    tabId: 'term-1',
    layout: overrides.layout,
    agentStatusByPaneKey: (overrides.agentStatusByPaneKey ?? {}) as Record<
      string,
      AgentStatusEntry
    >,
    retainedAgentsByPaneKey: (overrides.retainedAgentsByPaneKey ?? {}) as Record<
      string,
      RetainedAgentEntry
    >,
    sleepingAgentSessionsByPaneKey: (overrides.sleepingAgentSessionsByPaneKey ?? {}) as Record<
      string,
      SleepingAgentSessionRecord
    >
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
})

describe('resolveTabAgentSessionId', () => {
  it('reads the focused pane ahead of its siblings', () => {
    const sessionId = resolveTabAgentSessionId(
      sessionArgs({
        layout: splitLayout(SIBLING_LEAF),
        agentStatusByPaneKey: {
          [`term-1:${FOCUSED_LEAF}`]: { providerSession: { key: 'session_id', id: 'first' } },
          [`term-1:${SIBLING_LEAF}`]: { providerSession: { key: 'session_id', id: 'second' } }
        }
      })
    )

    expect(sessionId).toBe('second')
  })

  it('falls back to a sibling pane that has a session', () => {
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

  it('keeps finished and slept agents copyable', () => {
    expect(
      resolveTabAgentSessionId(
        sessionArgs({
          layout: splitLayout(FOCUSED_LEAF),
          retainedAgentsByPaneKey: {
            [`term-1:${FOCUSED_LEAF}`]: {
              entry: { providerSession: { key: 'session_id', id: 'retained' } }
            }
          }
        })
      )
    ).toBe('retained')

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

  it('reports no session for a plain shell tab', () => {
    expect(resolveTabAgentSessionId(sessionArgs({ layout: splitLayout(FOCUSED_LEAF) }))).toBeNull()
  })
})
