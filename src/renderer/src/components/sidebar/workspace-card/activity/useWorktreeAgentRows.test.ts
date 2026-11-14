import { describe, expect, it } from 'vitest'

import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID_1 = '22222222-2222-4222-8222-222222222222'
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

describe('buildWorktreeAgentRows', () => {
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

      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'Codex working'
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-parent']
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID_1 },
          activeLeafId: LEAF_ID_1,
          expandedLeafId: null
        }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.paneKey, row.state])).toEqual([[childPaneKey, 'done']])
  })
})
