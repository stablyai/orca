import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import {
  deriveRunningAgentSendTargets,
  type RunningAgentTargetState
} from './running-agent-targets'
import {
  deriveNotesSendAgentTargets,
  type NotesSendAgentTargetState
} from './notes-send-agent-targets'

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const NOW = 90 * 60 * 1000
const STALE_UPDATED_AT = NOW - AGENT_STATUS_STALE_AFTER_MS - 1

function tab(title: string): TerminalTab {
  return {
    id: TAB_ID,
    worktreeId: WORKTREE_ID,
    ptyId: PTY_ID,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
  }
}

function staleEntry(): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'done',
    prompt: '',
    updatedAt: STALE_UPDATED_AT,
    stateStartedAt: STALE_UPDATED_AT,
    agentType: 'codex',
    stateHistory: []
  }
}

function baseState(args: {
  tabTitle: string
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  foreground?: PaneForegroundAgentEntry
}): NotesSendAgentTargetState {
  return {
    agentStatusByPaneKey: args.agentStatusByPaneKey ?? {},
    tabsByWorktree: { [WORKTREE_ID]: [tab(args.tabTitle)] },
    terminalLayoutsByTabId: { [TAB_ID]: layout() },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    runtimePaneTitlesByTabId: {},
    paneForegroundAgentByPaneKey: args.foreground ? { [PANE_KEY]: args.foreground } : {}
  } as NotesSendAgentTargetState
}

describe('running agent send targets: live foreground process proof', () => {
  it('keeps a stale hook row sendable when the pane foreground still runs the agent', () => {
    const targets = deriveRunningAgentSendTargets(
      baseState({
        tabTitle: 'zsh',
        agentStatusByPaneKey: { [PANE_KEY]: staleEntry() },
        foreground: { agent: 'codex', shellForeground: false }
      }) as RunningAgentTargetState,
      WORKTREE_ID,
      NOW
    )

    expect(targets).toMatchObject([{ paneKey: PANE_KEY, ptyId: PTY_ID, status: 'eligible' }])
    expect(targets[0]).not.toHaveProperty('disabledReason')
  })

  it('still disables a stale hook row once the foreground is proven back at the shell', () => {
    const targets = deriveRunningAgentSendTargets(
      baseState({
        tabTitle: 'zsh',
        agentStatusByPaneKey: { [PANE_KEY]: staleEntry() },
        foreground: { agent: null, shellForeground: true }
      }) as RunningAgentTargetState,
      WORKTREE_ID,
      NOW
    )

    expect(targets).toMatchObject([
      { paneKey: PANE_KEY, status: 'disabled', disabledReason: 'Agent status is stale' }
    ])
  })

  it('disables a stale hook row when no foreground evidence exists at all', () => {
    const targets = deriveRunningAgentSendTargets(
      baseState({
        tabTitle: 'zsh',
        agentStatusByPaneKey: { [PANE_KEY]: staleEntry() }
      }) as RunningAgentTargetState,
      WORKTREE_ID,
      NOW
    )

    expect(targets).toMatchObject([
      { paneKey: PANE_KEY, status: 'disabled', disabledReason: 'Agent status is stale' }
    ])
  })
})

describe('notes send agent targets: live foreground process proof', () => {
  it('lists a hookless, title-silent pane whose foreground process is a known agent', () => {
    const targets = deriveNotesSendAgentTargets(
      baseState({
        tabTitle: 'zsh',
        foreground: { agent: 'claude', shellForeground: false }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toMatchObject([
      { paneKey: PANE_KEY, tabId: TAB_ID, leafId: LEAF_ID, agentType: 'claude', status: 'eligible' }
    ])
  })

  it('omits a title-silent pane whose foreground is back at the shell', () => {
    const targets = deriveNotesSendAgentTargets(
      baseState({
        tabTitle: 'zsh',
        foreground: { agent: 'claude', shellForeground: true }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })
})
