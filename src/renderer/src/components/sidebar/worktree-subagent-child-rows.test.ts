import { describe, expect, it } from 'vitest'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// Minimal fixture: buildSubagentChildRows only reads a handful of TerminalTab
// fields (id) through the row it returns; the rest is never touched.
function createTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}
const tab = createTab()

function parentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 100,
    stateStartedAt: 100,
    paneKey: 'tab-1:leaf-1',
    stateHistory: [],
    subagents: [
      {
        id: 'child-1',
        agentType: 'general-purpose',
        description: 'Deep review',
        state: 'working',
        startedAt: 50
      }
    ],
    ...overrides
  }
}

describe('buildSubagentChildRows', () => {
  // Why: issue #8251 — a sub-agent row must carry its own identity, never a
  // fabricated 'subagent:<id>' masquerading as a real Task/Dispatch id that
  // consumers (lineage layout, dashboard, worker-show) could mistake for one.
  it('gives a subagent row its own identity instead of a fabricated dispatch id', () => {
    const [row] = buildSubagentChildRows({
      parentEntry: parentEntry(),
      tab,
      parentIsFresh: true
    })

    expect(row.entry.subagent).toEqual({ id: 'child-1', parentPaneKey: 'tab-1:leaf-1' })
    expect(row.entry.orchestration?.dispatchId).toBeUndefined()
    expect(row.entry.orchestration?.taskId).toBeUndefined()
  })

  it('still activates against the parent pane', () => {
    const [row] = buildSubagentChildRows({
      parentEntry: parentEntry(),
      tab,
      parentIsFresh: true
    })

    expect(row.activationPaneKey).toBe('tab-1:leaf-1')
    expect(row.rowSource).toBe('subagent')
  })

  // K1: a stale roster (`subagentObservation: 'unverifiable'`) plus a last-reported 'idle' child
  // synthesized 'idle' — a row default of "nothing is known, so call it idle" wearing the one
  // subagent.state value the old check didn't already route to 'unverifiable'.
  it('reports unverifiable, not idle, for a stale roster observation', () => {
    const [row] = buildSubagentChildRows({
      parentEntry: parentEntry({
        subagentObservation: 'unverifiable',
        subagents: [
          {
            id: 'child-1',
            agentType: 'general-purpose',
            state: 'idle',
            startedAt: 50
          }
        ]
      }),
      tab,
      parentIsFresh: true
    })

    expect(row.state).toBe('unverifiable')
  })

  // K1: an absent observation on a stale parent is exactly as unknown as an explicit
  // 'unverifiable' one — it must not default to idle just because nothing said otherwise.
  it('reports unverifiable, not idle, when the parent itself is stale and observation is absent', () => {
    const [row] = buildSubagentChildRows({
      parentEntry: parentEntry({
        subagentObservation: undefined,
        subagents: [
          {
            id: 'child-1',
            agentType: 'general-purpose',
            state: 'working',
            startedAt: 50
          }
        ]
      }),
      tab,
      parentIsFresh: false
    })

    expect(row.state).toBe('unverifiable')
  })

  it('still trusts a fresh idle report', () => {
    const [row] = buildSubagentChildRows({
      parentEntry: parentEntry({
        subagentObservation: 'live',
        subagents: [
          {
            id: 'child-1',
            agentType: 'general-purpose',
            state: 'idle',
            startedAt: 50
          }
        ]
      }),
      tab,
      parentIsFresh: true
    })

    expect(row.state).toBe('idle')
  })
})
