import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { collectChildAgentPaneKeys } from './activity-thread-child-agent'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_3
} from './ActivityPrototypePage-test-fixtures'

function makeTestEntry(
  paneKey: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    ...makeWorkingEntryWithoutHistory(),
    paneKey,
    state: 'done',
    prompt: 'test prompt',
    stateHistory: [],
    ...overrides
  }
}

function makeTestThread(
  paneKey: string,
  overrides: Partial<AgentPaneThread> = {}
): AgentPaneThread {
  const worktree = makeWorktree()
  return {
    paneKey,
    paneTitle: 'Test Agent',
    agentType: 'claude',
    worktree,
    repo: makeRepo(),
    tab: makeTabWithIds('tab-1', worktree.id),
    events: [],
    latestEvent: null,
    latestTimestamp: 1000,
    currentAgentState: 'working',
    currentAgentEntry: makeTestEntry(paneKey),
    unread: false,
    responsePreview: '',
    ...overrides
  }
}

function makeEventFor(entry: AgentStatusEntry): ActivityEvent {
  const worktree = makeWorktree()
  return {
    id: `event-${entry.paneKey}`,
    state: 'done',
    timestamp: 1000,
    unread: false,
    worktree,
    repo: null,
    tab: makeTabWithIds('tab-1', worktree.id),
    agentType: 'claude',
    agentAlive: true,
    entry
  }
}

describe('collectChildAgentPaneKeys', () => {
  it('returns an empty set when no thread carries orchestration', () => {
    const threads = [makeTestThread(PANE_KEY), makeTestThread(PANE_KEY_2)]
    expect(collectChildAgentPaneKeys(threads).size).toBe(0)
  })

  it('classifies a thread whose parent pane is listed as a child', () => {
    const parent = makeTestThread(PANE_KEY)
    const child = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    })
    expect(collectChildAgentPaneKeys([parent, child])).toEqual(new Set([PANE_KEY_2]))
  })

  it('promotes an orphan whose parent pane is no longer listed', () => {
    const orphan = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    })
    expect(collectChildAgentPaneKeys([orphan]).size).toBe(0)
  })

  it('ignores a self-referencing parentPaneKey', () => {
    const thread = makeTestThread(PANE_KEY, {
      currentAgentEntry: makeTestEntry(PANE_KEY, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    })
    expect(collectChildAgentPaneKeys([thread]).size).toBe(0)
  })

  it('resolves coordinatorHandle through a listed thread terminal handle', () => {
    const coordinator = makeTestThread(PANE_KEY, {
      currentAgentEntry: makeTestEntry(PANE_KEY, { terminalHandle: 'terminal-coord' })
    })
    const worker = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2, {
        terminalHandle: 'terminal-worker',
        orchestration: {
          coordinatorHandle: 'terminal-coord',
          taskId: 'task-1',
          dispatchId: 'ctx-1'
        }
      })
    })
    expect(collectChildAgentPaneKeys([coordinator, worker])).toEqual(new Set([PANE_KEY_2]))
  })

  it('promotes a worker whose coordinator handle matches no listed thread', () => {
    const worker = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2, {
        terminalHandle: 'terminal-worker',
        orchestration: { coordinatorHandle: 'terminal-gone', taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    })
    expect(collectChildAgentPaneKeys([worker]).size).toBe(0)
  })

  it('keeps child classification from an older event while the parent is listed', () => {
    const parent = makeTestThread(PANE_KEY)
    const childEntry = makeTestEntry(PANE_KEY_2, {
      orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
    })
    const child = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2),
      events: [makeEventFor(childEntry)]
    })
    expect(collectChildAgentPaneKeys([parent, child])).toEqual(new Set([PANE_KEY_2]))
  })

  it('classifies a grandchild chained through a listed child', () => {
    const root = makeTestThread(PANE_KEY)
    const child = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    })
    const grandchild = makeTestThread(PANE_KEY_3, {
      currentAgentEntry: makeTestEntry(PANE_KEY_3, {
        orchestration: { parentPaneKey: PANE_KEY_2, taskId: 'task-2', dispatchId: 'ctx-2' }
      })
    })
    expect(collectChildAgentPaneKeys([root, child, grandchild])).toEqual(
      new Set([PANE_KEY_2, PANE_KEY_3])
    )
  })

  it('promotes every member of a parent cycle instead of hiding them all', () => {
    const a = makeTestThread(PANE_KEY, {
      currentAgentEntry: makeTestEntry(PANE_KEY, {
        orchestration: { parentPaneKey: PANE_KEY_2, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
    })
    const b = makeTestThread(PANE_KEY_2, {
      currentAgentEntry: makeTestEntry(PANE_KEY_2, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-2', dispatchId: 'ctx-2' }
      })
    })
    expect(collectChildAgentPaneKeys([a, b]).size).toBe(0)
  })
})
