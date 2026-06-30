import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  deriveNotesSendAgentTargets,
  type NotesSendAgentTargetState
} from './notes-send-agent-targets'

const WORKTREE_ID = 'wt-1'
const STATUS_TAB_ID = 'tab-status'
const LAUNCH_TAB_ID = 'tab-launch'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const NOW = 10_000

function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId: WORKTREE_ID,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function entry(paneKey: string, state: AgentStatusState = 'done'): AgentStatusEntry {
  return {
    paneKey,
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    agentType: 'codex',
    stateHistory: []
  }
}

function leafLayout(leafId: string, ptyId: string | null): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [leafId]: ptyId } : {}
  }
}

function splitLayout(
  activeLeafId: string,
  ptyIdsByLeafId: Record<string, string>
): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    },
    activeLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function state(
  overrides: Partial<{
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    tabsByWorktree: Record<string, TerminalTab[]>
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
    ptyIdsByTabId: Record<string, string[]>
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  }> = {}
): NotesSendAgentTargetState {
  const terminalLayoutsByTabId = overrides.terminalLayoutsByTabId ?? {}
  return {
    agentStatusByPaneKey: {},
    tabsByWorktree: { [WORKTREE_ID]: [] },
    terminalLayoutsByTabId,
    ptyIdsByTabId: deriveLivePtyIdsByTabId(terminalLayoutsByTabId),
    runtimePaneTitlesByTabId: {},
    ...overrides
  } as NotesSendAgentTargetState
}

function deriveLivePtyIdsByTabId(
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(terminalLayoutsByTabId).map(([tabId, layout]) => [
      tabId,
      Object.values(layout.ptyIdsByLeafId ?? {})
    ])
  )
}

describe('notes send agent targets', () => {
  it('maps status-backed targets with their agent type and tab title', () => {
    const paneKey = makePaneKey(STATUS_TAB_ID, LEAF_A)
    const targets = deriveNotesSendAgentTargets(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'done') },
        tabsByWorktree: { [WORKTREE_ID]: [tab(STATUS_TAB_ID, { title: 'Terminal 1' })] },
        terminalLayoutsByTabId: { [STATUS_TAB_ID]: leafLayout(LEAF_A, 'pty-a') }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([
      {
        paneKey,
        tabId: STATUS_TAB_ID,
        leafId: LEAF_A,
        agentType: 'codex',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ])
  })

  it('keeps permission status-backed targets visible but disabled', () => {
    const paneKey = makePaneKey(STATUS_TAB_ID, LEAF_A)
    const targets = deriveNotesSendAgentTargets(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'waiting') },
        tabsByWorktree: { [WORKTREE_ID]: [tab(STATUS_TAB_ID, { title: 'Terminal 1' })] },
        terminalLayoutsByTabId: { [STATUS_TAB_ID]: leafLayout(LEAF_A, 'pty-a') }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([
      expect.objectContaining({
        paneKey,
        status: 'disabled',
        disabledReason: 'Agent needs permission'
      })
    ])
  })

  it('keeps status-backed working targets disabled when a live pane title needs permission', () => {
    const paneKey = makePaneKey(STATUS_TAB_ID, LEAF_A)
    const targets = deriveNotesSendAgentTargets(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'working') },
        tabsByWorktree: { [WORKTREE_ID]: [tab(STATUS_TAB_ID, { title: 'Codex working' })] },
        terminalLayoutsByTabId: { [STATUS_TAB_ID]: leafLayout(LEAF_A, 'pty-a') },
        runtimePaneTitlesByTabId: { [STATUS_TAB_ID]: { 1: 'Codex - action required' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([
      expect.objectContaining({
        paneKey,
        status: 'disabled',
        disabledReason: 'Agent needs permission'
      })
    ])
  })

  it('lists a launch-agent tab with a recognized pane title before any hook status', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Terminal 2', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex ready' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([
      {
        paneKey: makePaneKey(LAUNCH_TAB_ID, LEAF_B),
        tabId: LAUNCH_TAB_ID,
        leafId: LEAF_B,
        agentType: 'codex',
        tabTitle: 'Terminal 2',
        status: 'eligible'
      }
    ])
  })

  it('recognizes a launch-agent tab by its explicit ready tab title when no pane title is set', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex ready', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets.map((target) => target.paneKey)).toEqual([makePaneKey(LAUNCH_TAB_ID, LEAF_B)])
  })

  it('skips a launch-agent tab with only a bare agent-name title', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })

  it('disables a launch-agent tab with a permission pane title', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Terminal 2', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex - action required' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([
      expect.objectContaining({
        paneKey: makePaneKey(LAUNCH_TAB_ID, LEAF_B),
        status: 'disabled',
        disabledReason: 'Agent needs permission'
      })
    ])
  })

  it('disables a launch-agent tab with a permission tab title when no pane title is set', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            tab(LAUNCH_TAB_ID, { title: 'Codex - action required', launchAgent: 'codex' })
          ]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([
      expect.objectContaining({
        paneKey: makePaneKey(LAUNCH_TAB_ID, LEAF_B),
        status: 'disabled',
        disabledReason: 'Agent needs permission'
      })
    ])
  })

  it('skips a still-booting launch-agent tab whose title is not yet an agent', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Terminal 2', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'zsh' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })

  it('skips a launch-agent tab without a live pty', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, null) },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })

  it('skips a launch-agent tab when only stale layout PTY state remains', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex ready', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') },
        ptyIdsByTabId: { [LAUNCH_TAB_ID]: [] },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex ready' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })

  it('does not emit a launch hint for a tab already covered by a live status entry', () => {
    const paneKey = makePaneKey(LAUNCH_TAB_ID, LEAF_A)
    const targets = deriveNotesSendAgentTargets(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'working') },
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: {
          [LAUNCH_TAB_ID]: splitLayout(LEAF_B, { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' })
        },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 2: 'Codex' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      tabId: LAUNCH_TAB_ID,
      leafId: LEAF_A,
      status: 'eligible'
    })
  })

  it('skips a launch-agent tab whose active leaf is not a terminal leaf', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex', launchAgent: 'codex' })]
        },
        terminalLayoutsByTabId: {
          [LAUNCH_TAB_ID]: {
            root: { type: 'leaf', leafId: LEAF_B },
            activeLeafId: 'editor-pane',
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })

  it('does not list a plain terminal tab without a launch agent or status', () => {
    const targets = deriveNotesSendAgentTargets(
      state({
        tabsByWorktree: { [WORKTREE_ID]: [tab(LAUNCH_TAB_ID, { title: 'Codex ready' })] },
        terminalLayoutsByTabId: { [LAUNCH_TAB_ID]: leafLayout(LEAF_B, 'pty-b') },
        runtimePaneTitlesByTabId: { [LAUNCH_TAB_ID]: { 1: 'Codex ready' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toEqual([])
  })
})
