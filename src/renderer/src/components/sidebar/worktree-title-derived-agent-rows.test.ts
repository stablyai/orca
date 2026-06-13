import { describe, expect, it } from 'vitest'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
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

function makeSingleLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
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

  it('uses runtime orchestration metadata for title-derived worker rows', () => {
    const parentPaneKey = makePaneKey('tab-parent', LEAF_ID_1)
    const childPaneKey = makePaneKey('tab-child', LEAF_ID_2)
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: [makeTab('tab-parent'), makeTab('tab-child')],
        entries: [],
        retained: [],
        runtimePaneTitlesByTabId: {
          'tab-parent': { 1: '⠋ Codex' },
          'tab-child': { 1: '⠋ Claude Code' }
        },
        ptyIdsByTabId: {
          'tab-parent': ['pty-parent'],
          'tab-child': ['pty-child']
        },
        terminalLayoutsByTabId: {
          'tab-parent': makeSingleLayout(LEAF_ID_1),
          'tab-child': makeSingleLayout(LEAF_ID_2)
        },
        runtimeAgentOrchestrationByPaneKey: {
          [childPaneKey]: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            parentPaneKey
          }
        },
        now: 2000
      })
    )

    expect(rows.map((row) => row.paneKey)).toEqual([parentPaneKey, childPaneKey])
    expect(rows[0].lineage).toMatchObject({ depth: 0, childCount: 1 })
    expect(rows[1].lineage).toMatchObject({ depth: 1, childCount: 0 })
    expect(rows[1].entry.orchestration).toMatchObject({ parentPaneKey })
  })

  it('does not infer Claude Code from a spinner-only non-agent title', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ installing dependencies' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-plain'] },
      terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })

  it('does not add title-derived rows for the Claude agents management screen', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'claude agents' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-claude-agents'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })

  it('does not turn generic Codex-launched task titles into Claude Code rows', () => {
    const launchAgent: TuiAgent = 'codex'
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '✳ refactor split-pane status' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-codex'] },
      terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })
})
