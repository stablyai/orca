import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { worktreeAgentDisplayState } from './worktree-card-agent-display-state'

/** Build a completed agent row for display-state contract tests. */
function doneAgent(interrupted = false): DashboardAgentRow {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'done',
    agentType: 'opencode',
    startedAt: 1,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'OpenCode',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    entry: {
      state: 'done',
      prompt: 'Ship v2 support',
      updatedAt: 2,
      stateStartedAt: 2,
      stateHistory: [],
      paneKey: 'tab-1:leaf-1',
      ...(interrupted ? { interrupted: true } : {})
    }
  }
}

describe('worktreeAgentDisplayState', () => {
  it('keeps an unvisited completion visibly done', () => {
    const agent = doneAgent()

    expect(worktreeAgentDisplayState(agent, true)).toBe('done')
  })

  it('presents an acknowledged completion as idle without mutating raw status', () => {
    const agent = doneAgent()
    const displayed = worktreeAgentDisplayState(agent, false)

    expect(displayed).toBe('idle')
    expect(agent.state).toBe('done')
    expect(agent.entry.state).toBe('done')
  })

  it('preserves interrupted completion semantics after acknowledgement', () => {
    const agent = doneAgent(true)

    expect(worktreeAgentDisplayState(agent, false)).toBe('interrupted')
  })
})
