import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID_1 = '77777777-7777-4777-8777-777777777777'

function makeTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
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

function makeSingleLayout(leafId: string): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
}

function rowsFor(launchAgent: TerminalTab['launchAgent'], title: string) {
  return buildWorktreeAgentRows({
    tabs: [makeTab('tab-1', { launchAgent })],
    entries: [],
    retained: [],
    runtimePaneTitlesByTabId: { 'tab-1': { 1: title } },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
    now: 2000
  })
}

describe('reused pane title identity (#24854)', () => {
  it('does not let a free-text agent name take the pane from its owner', () => {
    expect(rowsFor('omp', '⠋ Review Codex behavior').map((row) => [row.agentType, row.state])).toEqual([
      ['omp', 'working']
    ])
  })

  it('reads a Jcode owner suffix as identity, not a mention', () => {
    expect(rowsFor('omp', '⠋ fix - Jcode').map((row) => row.agentType)).toEqual(['jcode'])
  })
})
