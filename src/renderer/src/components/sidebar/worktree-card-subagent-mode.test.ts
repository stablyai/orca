import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { prepareWorktreeCardAgents } from './worktree-card-subagent-mode'

function makeRow(
  paneKey: string,
  overrides: Partial<DashboardAgentRow> = {},
  parentPaneKey?: string
): DashboardAgentRow {
  return {
    paneKey,
    tab: {
      id: 'tab-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Agent',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1000
    },
    state: 'working',
    agentType: 'antigravity',
    startedAt: 1000,
    entry: {
      paneKey,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      agentType: 'antigravity',
      state: 'working',
      prompt: 'Prompt',
      updatedAt: 1000,
      stateStartedAt: 1000,
      stateHistory: [],
      ...(parentPaneKey
        ? { orchestration: { parentPaneKey, taskId: 'task-1', dispatchId: 'disp-1' } }
        : {})
    },
    ...overrides
  }
}

describe('prepareWorktreeCardAgents', () => {
  const parent = makeRow('tab-1:1')
  const subagent = makeRow(
    'tab-1:1\0subagent:sub-1',
    {
      rowSource: 'subagent',
      activationPaneKey: 'tab-1:1'
    },
    'tab-1:1'
  )
  const worker = makeRow(
    'tab-2:1',
    {
      rowSource: 'live'
    },
    'tab-1:1'
  )

  it('promotes in-process subagents alongside agents at root level in flat mode while preserving multi-pane orchestration trees', () => {
    const prepared = prepareWorktreeCardAgents([parent, subagent, worker], {
      showSubagents: true,
      subagentDisplayMode: 'flat'
    })
    const tree = buildAgentRowLineageTree(prepared)
    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['tab-1:1', 'tab-1:1\0subagent:sub-1'])
    expect(tree.rootRows[1]?.activationPaneKey).toBe('tab-1:1')
    expect(tree.rootRows[1]?.rowSource).toBe('subagent')
    expect(tree.childrenByParentPaneKey.get('tab-1:1')?.map((row) => row.paneKey)).toEqual([
      'tab-2:1'
    ])
  })

  it('nests subagents under their parent in tree mode', () => {
    const prepared = prepareWorktreeCardAgents([parent, subagent], {
      showSubagents: true,
      subagentDisplayMode: 'tree'
    })
    const tree = buildAgentRowLineageTree(prepared)
    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['tab-1:1'])
    expect(tree.childrenByParentPaneKey.get('tab-1:1')?.map((row) => row.paneKey)).toEqual([
      'tab-1:1\0subagent:sub-1'
    ])
  })

  it('filters out subagent rows when showSubagents is false', () => {
    const prepared = prepareWorktreeCardAgents([parent, subagent, worker], {
      showSubagents: false,
      subagentDisplayMode: 'flat'
    })
    expect(prepared.map((row) => row.paneKey)).toEqual(['tab-1:1', 'tab-2:1'])
  })
})
