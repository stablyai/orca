import { describe, expect, it } from 'vitest'

import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status/agent-status-contract'

import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID_1 = '22222222-2222-4222-8222-222222222222'
const LEAF_ID_1_SECOND = '77777777-7777-4777-8777-777777777777'
const PANE_KEY_1 = makePaneKey('tab-1', LEAF_ID_1)
const PANE_KEY_2 = makePaneKey('tab-2', '33333333-3333-4333-8333-333333333333')
const PANE_KEY_3 = makePaneKey('tab-3', '55555555-5555-4555-8555-555555555555')

function makeTab(id: string, overrides?: Partial<TerminalTab>): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeEntry(
  paneKey: string,
  startedAt: number,
  overrides?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    stateStartedAt: startedAt,
    updatedAt: startedAt,
    stateHistory: [],
    prompt: 'finished prompt',
    agentType: 'claude',
    terminalTitle: undefined,
    interrupted: false,
    ...overrides
  }
}

function makeRetained(
  paneKey: string,
  worktreeId: string,
  startedAt: number,
  overrides?: Partial<RetainedAgentEntry>
): RetainedAgentEntry {
  const tab = makeTab(paneKey.slice(0, paneKey.indexOf(':')))
  return {
    entry: makeEntry(paneKey, startedAt),
    worktreeId,
    tab,
    agentType: 'claude',
    startedAt,
    ...overrides
  }
}

function makeSinglePaneLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

function makeSplitPaneLayout(firstLeafId: string, secondLeafId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: firstLeafId },
      second: { type: 'leaf', leafId: secondLeafId }
    },
    activeLeafId: firstLeafId,
    expandedLeafId: null
  }
}

describe('buildWorktreeAgentRows', () => {
  it('prefers a live row over a retained snapshot with the same paneKey', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained(PANE_KEY_1, 'wt-1', 1000)],
      now: 3000
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].entry).toBe(liveEntry)
    expect(rows[0].startedAt).toBe(2000)
  })

  it('dedupes retained legacy numeric rows for a single current stable pane', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000, {
      state: 'working',
      agentType: 'copilot',
      prompt: 'current turn'
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained('tab-1:1', 'wt-1', 1000), makeRetained('tab-1:2', 'wt-1', 1500)],
      terminalLayoutsByTabId: {
        'tab-1': makeSinglePaneLayout(LEAF_ID_1)
      },
      now: 3000
    })

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1])
  })

  it('keeps a retained legacy numeric row for a different split pane', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000, {
      state: 'working',
      agentType: 'copilot',
      prompt: 'current turn'
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained('tab-1:1', 'wt-1', 1000), makeRetained('tab-1:2', 'wt-1', 1500)],
      terminalLayoutsByTabId: {
        'tab-1': makeSplitPaneLayout(LEAF_ID_1, LEAF_ID_1_SECOND)
      },
      now: 3000
    })

    expect(rows.map((row) => row.paneKey)).toEqual(['tab-1:2', PANE_KEY_1])
  })

  it('keeps simultaneous worktree-attributed agents in a deterministic order', () => {
    const first = makeEntry(PANE_KEY_1, 1000, {
      state: 'working',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      prompt: 'omp worker'
    })
    const second = makeEntry(PANE_KEY_2, 1000, {
      state: 'working',
      worktreeId: 'wt-1',
      tabId: 'tab-2',
      prompt: 'omp worker'
    })
    const third = makeEntry(PANE_KEY_3, 1000, {
      state: 'working',
      worktreeId: 'wt-1',
      tabId: 'tab-3',
      prompt: 'omp worker'
    })

    const build = (entries: AgentStatusEntry[]) =>
      buildWorktreeAgentRows({
        tabs: [],
        entries,
        retained: [],
        now: 2000
      }).map((row) => row.paneKey)

    // Worker arrival/status-map iteration order must not reorder agents whose tabs have not hydrated.
    expect(build([third, first, second])).toEqual([PANE_KEY_1, PANE_KEY_2, PANE_KEY_3])
    expect(build([{ ...second, updatedAt: 1500 }, third, first])).toEqual([
      PANE_KEY_1,
      PANE_KEY_2,
      PANE_KEY_3
    ])
  })

  it('does not synthesize a working parent row for a completed worktree-attributed worker', () => {
    const parentPaneKey = PANE_KEY_1
    const childPaneKey = PANE_KEY_2
    const child = makeEntry(childPaneKey, 1000, {
      state: 'done',
      worktreeId: 'wt-1',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey
      }
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [child],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'Codex working'
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-parent']
      },
      terminalLayoutsByTabId: {
        'tab-1': makeSinglePaneLayout(LEAF_ID_1)
      },
      now: 2000
    })

    expect(rows.map((row) => [row.paneKey, row.state])).toEqual([[childPaneKey, 'done']])
  })
})
