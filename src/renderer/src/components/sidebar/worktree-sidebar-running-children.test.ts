// The worktree sidebar and the chat's strip list running children only, by one rule, whichever
// source they read them from, an older host's own task roster included.

import { describe, expect, it } from 'vitest'
import {
  agentChildWorkIsRunning,
  structuredRunningChildWork
} from '../../../../shared/agent-child-work-listing'
import { buildLegacyTaskRowModels } from '../../../../shared/agent-child-row-model'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import type { AgentStatusEntry, AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  buildBackgroundTaskGroups,
  buildBackgroundTaskGroupsFromViews
} from '@/components/native-chat/background-task-roster'
import { structuredSessionBackgroundTasksView } from '@/components/native-chat/structured-session-background-tasks-view'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

const NOW = 1_000_000

const tab: TerminalTab = {
  id: 'parent-tab',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'Parent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function parent(fields: Pick<AgentStatusEntry, 'children' | 'subagents'>): AgentStatusEntry {
  return {
    paneKey: 'parent-tab:leaf-1',
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    state: 'done',
    prompt: 'parent prompt',
    updatedAt: NOW,
    stateStartedAt: NOW - 60_000,
    stateHistory: [],
    ...fields
  }
}

function view(id: string, over: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    providerId: `task-${id}`,
    kind: 'agent',
    description: `child ${id}`,
    state: 'working',
    membership: 'live',
    firstObservedAt: NOW - 5_000,
    observedAt: NOW - 1_000,
    stoppable: false,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...over
  }
}

const finished = (id: string): AgentChildWorkView =>
  view(id, { state: 'done', membership: 'settled', outcome: 'succeeded', settledAt: NOW - 2_000 })

const sidebarNames = (entry: AgentStatusEntry) =>
  buildSubagentChildRows({ parentEntry: entry, tab, parentIsFresh: true }).map(
    (row) => row.entry.prompt
  )

describe('the worktree sidebar lists running children only', () => {
  it("drops a chat session's finished child from the sidebar and the strip alike", () => {
    const children = [view('a'), finished('b')]
    expect(sidebarNames(parent({ children }))).toEqual(['child a'])
    const [agents] = buildBackgroundTaskGroupsFromViews(structuredRunningChildWork(children))
    expect(agents.tasks.map((entry) => entry.row.name)).toEqual(['child a'])
    expect(structuredRunningChildWork([finished('b')])).toEqual([])
  })

  it('keeps a finished child whose shell still runs: it reads monitoring', () => {
    const children = [
      finished('owner'),
      view('shell', { kind: 'command', description: 'npm run dev', parentChildWorkId: 'owner' })
    ]
    const [row] = buildSubagentChildRows({
      parentEntry: parent({ children }),
      tab,
      parentIsFresh: true
    })
    expect(row?.childRow?.displayState).toBe('monitoring')
  })

  // A terminal agent's hook roster holds live children only: its finished child left the roster on
  // its own stop, so the sidebar has none to list. Every child it does hold runs, and all of them
  // show, a teammate between turns and a child gone quiet included.
  it("lists every child a terminal agent's hook roster holds", () => {
    const subagents: AgentSubagentSnapshot[] = [
      { id: 'working', state: 'working', startedAt: NOW, description: 'Working child' },
      { id: 'waiting', state: 'waiting', startedAt: NOW, description: 'Waiting child' },
      { id: 'teammate', state: 'idle', startedAt: NOW, description: 'Idle teammate' },
      { id: 'quiet', state: 'unverifiable', startedAt: NOW, description: 'Quiet child' }
    ]
    expect(sidebarNames(parent({ subagents }))).toEqual([
      'Working child',
      'Waiting child',
      'Idle teammate',
      'Quiet child'
    ])
    expect(sidebarNames(parent({ subagents: [] }))).toEqual([])
  })

  it("applies the one rule to a finished child from an older host's task roster, on both surfaces", () => {
    const tasks = [
      { id: 'live', kind: 'agent' as const, description: 'Live task', state: 'working' as const }
    ]
    const settledTasks = [{ id: 'done', kind: 'agent' as const, description: 'Done task' }]
    const rows = buildLegacyTaskRowModels(tasks, settledTasks)
    expect(
      rows
        .filter((row) => agentChildWorkIsRunning({ settled: row.settled, ownsLiveWork: false }))
        .map((row) => row.name)
    ).toEqual(['Live task'])
    const strip = structuredSessionBackgroundTasksView(
      { state: 'monitoring', tasks, settledTasks },
      null
    )
    const [agents] = buildBackgroundTaskGroups(strip.tasks, strip.settledTasks)
    expect(agents.tasks.map((entry) => entry.row.name)).toEqual(['Live task'])
  })
})
