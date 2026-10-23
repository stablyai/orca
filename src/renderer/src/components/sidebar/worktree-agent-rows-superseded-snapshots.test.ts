import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const OTHER_PANE_KEY = makePaneKey('tab-2', '33333333-3333-4333-8333-333333333333')
const tab: TerminalTab = {
  id: 'tab-1',
  worktreeId: 'wt-1',
  ptyId: 'pty-1',
  title: 'zsh',
  defaultTitle: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  launchAgent: 'omp'
}
const entry: AgentStatusEntry = {
  paneKey: PANE_KEY,
  state: 'done',
  agentType: 'codex',
  prompt: '',
  stateStartedAt: 1000,
  updatedAt: 1000,
  stateHistory: []
}
const base = {
  tabs: [tab],
  now: 2000,
  ptyIdsByTabId: { 'tab-1': ['pty-1'] },
  terminalLayoutsByTabId: {
    'tab-1': {
      root: { type: 'leaf' as const, leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null
    }
  },
  paneForegroundAgentByPaneKey: {
    [PANE_KEY]: {
      agent: 'omp' as const,
      agentEvidence: 'process-read' as const,
      shellForeground: false
    }
  }
}

describe('superseded completed sidebar snapshots', () => {
  it('drops the live snapshot under a shell title without hiding another pane', () => {
    const rows = buildWorktreeAgentRows({
      ...base,
      tabs: [tab, { ...tab, id: 'tab-2', ptyId: null }],
      entries: [entry, { ...entry, paneKey: OTHER_PANE_KEY }],
      retained: []
    })
    expect(rows.map((row) => row.paneKey)).toEqual([OTHER_PANE_KEY])
  })

  it('drops a retained snapshot when the replacement still has a shell title', () => {
    const rows = buildWorktreeAgentRows({
      ...base,
      entries: [],
      retained: [{ entry, tab, worktreeId: 'wt-1', agentType: 'codex', startedAt: 1000 }]
    })
    expect(rows).toEqual([])
  })

  it('does not reintroduce an attributed snapshot whose tab is absent', () => {
    const rows = buildWorktreeAgentRows({
      ...base,
      tabs: [],
      entries: [{ ...entry, worktreeId: 'wt-1', tabId: 'tab-1' }],
      retained: []
    })
    expect(rows).toEqual([])
  })
})
