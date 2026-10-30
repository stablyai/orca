import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { getAgentDotState } from './worktree-card-agent-summary'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

function monitoringAgent(): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'working',
    agentType: 'claude',
    startedAt: 1,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    entry: {
      state: 'working',
      workingMode: 'monitoring',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      paneKey: 'tab-1:leaf-1'
    }
  }
}

describe('worktree card agent summary', () => {
  it('keeps a subagent row on its own state while its failed main agent reads failed', () => {
    const parent = monitoringAgent()
    parent.entry = {
      ...parent.entry,
      workingMode: undefined,
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 },
      subagents: [{ id: 'child-1', state: 'working', startedAt: 1 }]
    }
    const [child] = buildSubagentChildRows({
      parentEntry: parent.entry,
      tab: parent.tab,
      parentIsFresh: true
    })

    expect(getAgentDotState(parent)).toBe('failed')
    expect(getAgentDotState(child)).toBe('working')
  })
})
