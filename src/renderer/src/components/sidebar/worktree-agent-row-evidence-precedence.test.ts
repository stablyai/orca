import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID = '77777777-7777-4777-8777-777777777777'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    launchAgent: 'codex'
  }
}

function makeLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null
  }
}

describe('worktree agent row evidence precedence', () => {
  it('lets current same-agent process and title evidence replace a stale hook and its subagents', () => {
    const updatedAt = 1000
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab()],
      entries: [
        {
          paneKey: PANE_KEY,
          agentType: 'codex',
          state: 'working',
          prompt: 'Previous Codex task',
          updatedAt,
          stateStartedAt: updatedAt,
          stateHistory: [],
          subagents: [{ id: 'stale-child', state: 'working', startedAt: updatedAt }]
        }
      ],
      retained: [],
      runtimePaneTitlesByTabId: { 'tab-1': { 1: '⠋ Codex is thinking' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'codex', shellForeground: false }
      },
      now: updatedAt + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    expect(rows.map((row) => [row.rowSource, row.agentType, row.state, row.entry.prompt])).toEqual([
      ['live', 'codex', 'working', 'Codex']
    ])
  })

  it('removes a loading row and its subagents as soon as the pane returns to the shell', () => {
    const updatedAt = 1000
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab()],
      entries: [
        {
          paneKey: PANE_KEY,
          agentType: 'codex',
          state: 'working',
          prompt: 'Finished Codex task',
          updatedAt,
          stateStartedAt: updatedAt,
          stateHistory: [],
          subagents: [{ id: 'finished-child', state: 'working', startedAt: updatedAt }]
        }
      ],
      retained: [],
      runtimePaneTitlesByTabId: { 'tab-1': { 1: '⠋ stale task title' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: null, shellForeground: true }
      },
      now: updatedAt
    })

    expect(rows).toEqual([])
  })

  it('keeps a confirmed Codex process when a stale idle title names Antigravity', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab()],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: { 'tab-1': { 1: 'Antigravity' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() },
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'codex', shellForeground: false }
      },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.prompt])).toEqual([
      ['codex', 'idle', 'Codex']
    ])
  })
})
