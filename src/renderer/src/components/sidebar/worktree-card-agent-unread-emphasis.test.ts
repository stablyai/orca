import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AppState } from '@/store/types'
import { selectAgentUnreadEmphasis } from './worktree-card-agent-ack-inputs'

type AttentionState = Pick<
  AppState,
  'acknowledgedAgentsByPaneKey' | 'unreadAgentCompletionPanes' | 'manuallyUnreadTurnsByPaneKey'
>

function state(overrides: Partial<AttentionState> = {}): AttentionState {
  return {
    acknowledgedAgentsByPaneKey: {},
    unreadAgentCompletionPanes: {},
    manuallyUnreadTurnsByPaneKey: {},
    ...overrides
  }
}

function agent(overrides: Partial<DashboardAgentRow> = {}): DashboardAgentRow {
  return {
    paneKey: 'tab-a:leaf-a',
    state: 'done',
    rowSource: 'live',
    agentType: 'pi',
    startedAt: 100,
    tab: {
      id: 'tab-a',
      worktreeId: 'workspace-a',
      ptyId: null,
      title: 'Pi',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 100
    },
    entry: {
      paneKey: 'tab-a:leaf-a',
      state: 'done',
      stateStartedAt: 1000,
      updatedAt: 1000,
      prompt: 'Task',
      stateHistory: []
    },
    ...overrides
  }
}

const PANE = 'tab-a:leaf-a'

describe('sidebar agent unread emphasis', () => {
  it('waits for confirmed attention, without delaying the status itself', () => {
    const row = agent()
    expect(selectAgentUnreadEmphasis(state(), [row])).toEqual([false])
    expect(row.state).toBe('done')
    expect(
      selectAgentUnreadEmphasis(
        state({
          unreadAgentCompletionPanes: { [PANE]: 'agent-completion' }
        }),
        [row]
      )
    ).toEqual([true])
  })

  it('does not emphasize a transient completion that never earns unread attention', () => {
    expect(selectAgentUnreadEmphasis(state(), [agent()])).toEqual([false])
    const resumed = agent({ state: 'working' })
    expect(resumed.state).toBe('working')
    expect(
      selectAgentUnreadEmphasis(state({ acknowledgedAgentsByPaneKey: { [PANE]: 1000 } }), [resumed])
    ).toEqual([false])
    expect(selectAgentUnreadEmphasis(state(), [agent()])).toEqual([false])
  })

  it('does not borrow confirmation from another agent in the same card', () => {
    expect(
      selectAgentUnreadEmphasis(
        state({
          unreadAgentCompletionPanes: { [PANE]: 'agent-completion' }
        }),
        [agent(), agent({ paneKey: 'tab-a:leaf-b' })]
      )
    ).toEqual([true, false])
  })

  it('clears emphasis when acknowledged, even before the marker is removed', () => {
    expect(
      selectAgentUnreadEmphasis(
        state({
          acknowledgedAgentsByPaneKey: { [PANE]: 1000 },
          unreadAgentCompletionPanes: { [PANE]: 'agent-completion' }
        }),
        [agent()]
      )
    ).toEqual([false])
  })

  it('preserves explicit mark-unread only for the marked turn', () => {
    expect(
      selectAgentUnreadEmphasis(
        state({
          manuallyUnreadTurnsByPaneKey: { [PANE]: 1000 }
        }),
        [agent()]
      )
    ).toEqual([true])
    expect(
      selectAgentUnreadEmphasis(
        state({
          manuallyUnreadTurnsByPaneKey: { [PANE]: 500 }
        }),
        [agent()]
      )
    ).toEqual([false])
  })

  it.each(['retained', 'subagent'] as const)(
    'preserves %s acknowledgements without a live completion marker',
    (rowSource) => {
      expect(selectAgentUnreadEmphasis(state(), [agent({ rowSource })])).toEqual([true])
      expect(
        selectAgentUnreadEmphasis(state({ acknowledgedAgentsByPaneKey: { [PANE]: 1000 } }), [
          agent({ rowSource })
        ])
      ).toEqual([false])
    }
  )

  it.each(['waiting', 'blocked', 'working'] as const)(
    'does not delay %s status emphasis',
    (status) => {
      expect(selectAgentUnreadEmphasis(state(), [agent({ state: status })])).toEqual([true])
    }
  )

  it('accepts legacy completion markers but not terminal bells', () => {
    expect(
      selectAgentUnreadEmphasis(state({ unreadAgentCompletionPanes: { [PANE]: true } }), [agent()])
    ).toEqual([true])
    expect(
      selectAgentUnreadEmphasis(
        state({ unreadAgentCompletionPanes: { [PANE]: 'terminal-bell' } }),
        [agent()]
      )
    ).toEqual([false])
  })

  it('keeps unrelated attention updates shallow-equal', () => {
    const rows = [agent()]
    expect(
      shallow(
        selectAgentUnreadEmphasis(state(), rows),
        selectAgentUnreadEmphasis(
          state({
            unreadAgentCompletionPanes: { other: 'agent-completion' },
            acknowledgedAgentsByPaneKey: { other: 2000 },
            manuallyUnreadTurnsByPaneKey: { other: 2000 }
          }),
          rows
        )
      )
    ).toBe(true)
  })

  it.each([null, 'paired-host', 'ssh-host'])(
    'uses the same marker for connection %s',
    (connectionId) => {
      const row = agent()
      row.entry.connectionId = connectionId
      expect(selectAgentUnreadEmphasis(state(), [row])).toEqual([false])
      expect(
        selectAgentUnreadEmphasis(
          state({ unreadAgentCompletionPanes: { [PANE]: 'agent-completion' } }),
          [row]
        )
      ).toEqual([true])
    }
  )
})
