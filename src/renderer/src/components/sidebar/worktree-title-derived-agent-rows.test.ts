import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID_1 = '77777777-7777-4777-8777-777777777777'
const LEAF_ID_2 = '88888888-8888-4888-8888-888888888888'

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeSplitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID_1 },
      second: { type: 'leaf', leafId: LEAF_ID_2 }
    },
    activeLeafId: LEAF_ID_1,
    expandedLeafId: null
  }
}

describe('buildTitleDerivedAgentRows', () => {
  it('adds title-derived rows for live agent panes that have no hook status yet', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'Antigravity',
          2: '⠋ Codex'
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
      terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.lastAssistantMessage])).toEqual([
      ['antigravity', 'idle', 'Idle'],
      ['codex', 'working', 'Running']
    ])
    expect(rows.map((row) => row.paneKey)).toEqual([
      makePaneKey('tab-1', LEAF_ID_1),
      makePaneKey('tab-1', LEAF_ID_2)
    ])
  })

  it('does not add title-derived rows for panes without a live PTY', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ Codex' }
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })
})
