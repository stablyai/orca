import { describe, expect, it } from 'vitest'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS } from '@/store/slices/pane-foreground-agent'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
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

  // Why: wrapper-launched claude (zsh function exec'ing the real binary) emits
  // Claude activity titles without the literal "claude" token; fresh process
  // identity must attribute the row instead.
  it('builds a Claude row for a token-less Claude activity title with fresh claude process identity', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'orca-wrapper' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠐ refactor split-pane status' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-claude'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: {
          agent: 'claude',
          shellForeground: false,
          observedAt: 1_900,
          ptyId: 'pty-claude'
        }
      },
      now: 2_000
    })

    expect(rows.map((row) => [row.agentType, row.state])).toEqual([['claude', 'working']])
    expect(rows[0].paneKey).toBe(paneKey)
  })

  it('does not attribute Claude from stale (past-TTL) process evidence', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const now = 100_000
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'orca-wrapper' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠐ refactor split-pane status' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-claude'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: {
          agent: 'claude',
          shellForeground: false,
          observedAt: now - PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS - 1,
          ptyId: 'pty-claude'
        }
      },
      now
    })

    expect(rows).toHaveLength(0)
  })

  it('does not attribute Claude from evidence whose PTY is no longer live', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'orca-wrapper' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠐ refactor split-pane status' }
      },
      // The pane respawned onto a different PTY; the old evidence must not bind.
      ptyIdsByTabId: { 'tab-1': ['pty-respawned'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'claude', shellForeground: false, observedAt: 1_900, ptyId: 'pty-dead' }
      },
      now: 2_000
    })

    expect(rows).toHaveLength(0)
  })

  it('keeps the hook row (not a duplicate title-derived row) when both exist for a pane', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID_1)
    const hookEntry: AgentStatusEntry = {
      paneKey,
      state: 'working',
      prompt: '',
      updatedAt: 1_900,
      stateStartedAt: 1_900,
      stateHistory: [],
      agentType: 'codex'
    }
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { title: 'orca-wrapper' })],
      entries: [hookEntry],
      retained: [],
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: '⠐ refactor split-pane status' }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-claude'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      paneForegroundAgentByPaneKey: {
        [paneKey]: {
          agent: 'claude',
          shellForeground: false,
          observedAt: 1_900,
          ptyId: 'pty-claude'
        }
      },
      now: 2_000
    })

    expect(rows.map((row) => [row.agentType, row.rowSource])).toEqual([['codex', 'live']])
  })

  // Why: non-braille Claude activity markers without a Claude token must not
  // invent a Claude row from launchAgent alone (split-pane residual risk).
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
