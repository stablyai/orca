import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID_1 = '77777777-7777-4777-8777-777777777777'
const LEAF_ID_2 = '88888888-8888-4888-8888-888888888888'

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
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
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

describe('launchAgent idle rows after a neutral title', () => {
  it('keeps an Idle row for a launchAgent tab when the title reverts to a neutral cwd (#10130)', () => {
    const launchAgent: TuiAgent = 'codex'
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'demo-repo' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-codex-remote-idle'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(
      rows.map((row) => [
        row.agentType,
        row.state,
        row.entry.prompt,
        row.entry.lastAssistantMessage
      ])
    ).toEqual([['codex', 'idle', 'Codex', 'Idle']])
  })

  it('keeps Idle for a launchAgent tab at a plain shell title while the PTY is live', () => {
    const launchAgent: TuiAgent = 'codex'
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'zsh' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-codex-shell'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state])).toEqual([['codex', 'idle']])
  })

  it('does not invent an Idle row for a neutral title without launch identity', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'demo-repo' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-plain'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })

  it('does not invent Idle launchAgent rows for every split pane with a neutral title', () => {
    const launchAgent: TuiAgent = 'codex'
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'demo-repo',
          2: 'zsh'
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
      terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })

  it('keeps an Idle row when the layout snapshot is temporarily unavailable', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [
        makeTab('tab-1', {
          title: 'demo-repo',
          launchAgent: 'codex',
          launchAgentLeafId: LEAF_ID_1
        })
      ],
      entries: [],
      retained: [],
      ptyIdsByTabId: { 'tab-1': ['pty-codex-remote-idle'] },
      now: 2000
    })

    expect(rows.map((row) => [row.paneKey, row.agentType, row.state])).toEqual([
      [makePaneKey('tab-1', LEAF_ID_1), 'codex', 'idle']
    ])
  })
})
