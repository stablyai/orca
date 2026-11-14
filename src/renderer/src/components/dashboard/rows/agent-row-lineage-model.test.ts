import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { DashboardAgentRow } from './dashboard-agent-row'
import { buildAgentRowLineageTree } from './agent-row-lineage-model'

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeRow(
  paneKey: string,
  options: {
    terminalHandle?: string
    parentPaneKey?: string
    parentTerminalHandle?: string
    coordinatorHandle?: string
  } = {}
): DashboardAgentRow {
  const orchestration =
    options.parentPaneKey || options.parentTerminalHandle || options.coordinatorHandle
      ? {
          taskId: `${paneKey}-task`,
          dispatchId: `${paneKey}-dispatch`,
          ...(options.parentPaneKey ? { parentPaneKey: options.parentPaneKey } : {}),
          ...(options.parentTerminalHandle
            ? { parentTerminalHandle: options.parentTerminalHandle }
            : {}),
          ...(options.coordinatorHandle ? { coordinatorHandle: options.coordinatorHandle } : {})
        }
      : undefined
  const entry: AgentStatusEntry = {
    paneKey,
    state: 'done',
    prompt: paneKey,
    updatedAt: 1000,
    stateStartedAt: 1000,
    stateHistory: [],
    agentType: 'codex',
    ...(options.terminalHandle ? { terminalHandle: options.terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }

  return {
    paneKey,
    entry,
    tab: makeTab(paneKey.split(':')[0] ?? paneKey),
    agentType: 'codex',
    state: 'done',
    startedAt: 1000
  }
}

describe('buildAgentRowLineageTree', () => {
  it('terminates a reachable cycle introduced by duplicate pane rows', () => {
    const root = makeRow('root')
    const first = makeRow('first', { parentPaneKey: 'root' })
    const second = makeRow('second', { parentPaneKey: 'first' })
    const duplicate = makeRow('first', { parentPaneKey: 'second' })
    const tree = buildAgentRowLineageTree([root, first, second, duplicate])
    expect(tree.rootRows).toEqual([root])
    expect([...tree.childPaneKeys]).toEqual(['first', 'second'])
    expect([...tree.childrenByParentPaneKey]).toEqual([
      ['root', [first]],
      ['first', [second]],
      ['second', [duplicate]]
    ])
  })
})

describe('unreachable lineage cleanup', () => {
  it('preserves reachable edges and promotes the first disconnected duplicate in input order', () => {
    const root = makeRow('root')
    const child = makeRow('child', { parentPaneKey: 'root' })
    const first = makeRow('cycle-a', { parentPaneKey: 'cycle-b' })
    const second = makeRow('cycle-b', { parentPaneKey: 'cycle-a' })
    const duplicate = makeRow('cycle-a', { parentPaneKey: 'cycle-b' })
    const descendant = makeRow('descendant', { parentPaneKey: 'cycle-b' })
    const tree = buildAgentRowLineageTree([first, root, child, second, duplicate, descendant])

    expect(tree.rootRows).toEqual([root, first, second, descendant])
    expect(tree.rootRows[1]).toBe(first)
    expect([...tree.childrenByParentPaneKey]).toEqual([['root', [child]]])
    expect([...tree.childPaneKeys]).toEqual(['child'])
  })
})
