import { describe, expect, it } from 'vitest'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
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

  it('normalizes Pi-compatible title-derived rows to the launched OMP owner', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'omp' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: '\u280b π: tmp'
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-omp'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.terminalTitle])).toEqual([
      ['omp', 'working', '\u280b OMP']
    ])
  })

  it('keeps Pi-compatible title-derived rows as Pi for launched Pi sessions', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'pi' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: '\u280b Pi'
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-pi'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.terminalTitle])).toEqual([
      ['pi', 'working', '\u280b Pi']
    ])
  })

  it('uses the shared title identity map for MiMo Code', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'MiMo Code ready' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-mimo'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state])).toEqual([['mimo-code', 'idle']])
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

  it('adds an idle Claude row for the Claude agents surface', () => {
    for (const title of [
      'claude agents',
      String.raw`C:\Users\dev\AppData\Roaming\npm\claude.cmd agents`
    ]) {
      const rows = buildWorktreeAgentRows({
        tabs: [makeTab('tab-1')],
        entries: [],
        retained: [],
        runtimePaneTitlesByTabId: {
          'tab-1': { 1: title }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-claude-agents'] },
        terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
        now: 2000
      })

      expect(rows.map((row) => [row.agentType, row.state, row.entry.lastAssistantMessage])).toEqual(
        [['claude', 'idle', 'Idle']]
      )
    }
  })

  it('attributes a spinner-only title to the launched agent when the title has no identity', () => {
    const launchAgent: TuiAgent = 'codex'
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        // Codex over SSH emits spinner + cwd titles with no agent name (#8711).
        'tab-1': { 1: '⠼ demo-repo' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-codex-remote'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(
      rows.map((row) => [row.agentType, row.state, row.entry.prompt, row.entry.terminalTitle])
    ).toEqual([['codex', 'working', 'Codex', '⠼ demo-repo']])
  })

  it('keeps explicit title identity over the launched agent', () => {
    const launchAgent: TuiAgent = 'claude'
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ Codex' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-explicit'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state])).toEqual([['codex', 'working']])
  })

  it.each([
    ['codex', '⠋ Claude icon investigation'],
    ['claude', '⠋ Codex icon investigation']
  ] as const)(
    'keeps launched %s identity when task text mentions another agent',
    (launchAgent, title) => {
      const rows = buildWorktreeAgentRows({
        tabs: [makeTab('tab-1', { launchAgent })],
        entries: [],
        retained: [],
        runtimePaneTitlesByTabId: {
          'tab-1': { 1: title }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-launched'] },
        terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
        now: 2000
      })

      expect(rows.map((row) => [row.agentType, row.state, row.entry.prompt])).toEqual([
        [launchAgent, 'working', launchAgent === 'codex' ? 'Codex' : 'Claude']
      ])
    }
  )

  it('uses foreground process identity when a manually started agent has no launch metadata', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'Terminal 1' })],
      entries: [],
      retained: [],
      ptyIdsByTabId: { 'tab-1': ['pty-manual'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.prompt])).toEqual([
      ['codex', 'idle', 'Codex']
    ])
  })

  it('prefers foreground process identity over another agent mentioned in task text', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ Claude icon investigation' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-manual'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.prompt])).toEqual([
      ['codex', 'working', 'Codex']
    ])
  })

  it('keeps live hook identity ahead of a conflicting foreground process', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [
        {
          paneKey,
          agentType: 'claude',
          state: 'working',
          prompt: 'Investigate the icon',
          updatedAt: 2000,
          stateStartedAt: 2000,
          stateHistory: []
        }
      ],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ Codex' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-hook'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false }
      },
      now: 2000
    })

    expect(rows.map((row) => row.agentType)).toEqual(['claude'])
  })

  it('lets a current foreground process replace a conflicting stale hook row', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const now = AGENT_STATUS_STALE_AFTER_MS + 2001
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'codex' })],
      entries: [
        {
          paneKey,
          agentType: 'claude',
          state: 'working',
          prompt: 'Previous Claude task',
          updatedAt: 2000,
          stateStartedAt: 2000,
          stateHistory: []
        }
      ],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ Codex is thinking' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-reused'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false }
      },
      now
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.prompt])).toEqual([
      ['codex', 'working', 'Codex']
    ])
  })

  it('normalizes a foreground Pi process to its launched OMP owner', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'omp', title: 'Terminal 1' })],
      entries: [],
      retained: [],
      ptyIdsByTabId: { 'tab-1': ['pty-omp'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'pi', shellForeground: false }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state])).toEqual([['omp', 'idle']])
  })

  it('includes a titleless foreground agent in an inactive split pane', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_2)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'Terminal 1' })],
      entries: [],
      retained: [],
      ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
      terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.paneKey, row.agentType, row.state])).toEqual([
      [paneKey, 'codex', 'idle']
    ])
  })

  it('ignores a stale foreground entry whose split leaf left the current layout', () => {
    const stalePaneKey = makePaneKey('tab-1', LEAF_ID_2)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'Terminal 1' })],
      entries: [],
      retained: [],
      ptyIdsByTabId: { 'tab-1': ['pty-current'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [stalePaneKey]: { agent: 'codex', shellForeground: false }
      },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })

  it('drops a stale title-derived row after the pane returns to the shell', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'codex' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠋ Codex is thinking' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-finished'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: null, shellForeground: true }
      },
      now: 2000
    })

    expect(rows).toHaveLength(0)
  })

  it('produces no row for a spinner-only title when the tab has no launch identity', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        // Spinner activity but no identity and no launchAgent to attribute it to.
        'tab-1': { 1: '⠼ demo-repo' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-anon'] },
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
