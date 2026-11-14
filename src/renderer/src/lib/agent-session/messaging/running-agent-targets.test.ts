import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  deriveRunningAgentSendTargets,
  type RunningAgentTargetState
} from './running-agent-targets'

const NOW = 1_800_000_000_000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const LEAF_ID = '0b9f6c1e-4a52-4d4f-9a55-1f3f6d2c7a10'
const SIBLING_LEAF_ID = '5d2a8e44-0c1b-4f7a-8b3e-9e6f1a2b3c4d'
const PANE_KEY = `tab-1:${LEAF_ID}`

function entry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: NOW - TWO_HOURS_MS,
    stateStartedAt: NOW - TWO_HOURS_MS,
    agentType: 'kiro',
    paneKey: PANE_KEY,
    ...overrides
  }
}

function state(
  statusEntry: AgentStatusEntry,
  livePtyIds: string[] | undefined,
  tabTitle = 'kiro-cli',
  root: TerminalPaneLayoutNode | null = null
): RunningAgentTargetState {
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt',
    title: tabTitle,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    agentStatusByPaneKey: { [PANE_KEY]: statusEntry },
    tabsByWorktree: { wt: [tab] },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        root,
        activeLeafId: root ? SIBLING_LEAF_ID : LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    ptyIdsByTabId: livePtyIds === undefined ? {} : { 'tab-1': livePtyIds },
    runtimePaneTitlesByTabId: {}
  }
}

function onlyTarget(s: RunningAgentTargetState) {
  const [target] = deriveRunningAgentSendTargets(s, 'wt')
  return { status: target.status, disabledReason: target.disabledReason }
}

describe('deriveRunningAgentSendTargets terminal liveness', () => {
  it('keeps a long-idle, title-less agent pane with a live PTY selectable', () => {
    expect(onlyTarget(state(entry({}), ['pty-1']))).toEqual({
      status: 'eligible',
      disabledReason: undefined
    })
  })

  it('keeps a restored agent pane with a live PTY selectable after restart', () => {
    expect(onlyTarget(state(entry({ restoredUnconfirmed: true }), ['pty-1']))).toEqual({
      status: 'eligible',
      disabledReason: undefined
    })
  })

  it('keeps an unanswered permission prompt disabled at any age', () => {
    expect(onlyTarget(state(entry({ state: 'blocked' }), ['pty-1']))).toEqual({
      status: 'disabled',
      disabledReason: 'Agent needs permission'
    })
  })

  it('does not let an idle-looking title clear an old permission row', () => {
    expect(
      onlyTarget(
        state(entry({ state: 'blocked', agentType: 'claude' }), ['pty-1'], '\u2733 Claude Code')
      )
    ).toEqual({ status: 'disabled', disabledReason: 'Agent needs permission' })
  })

  it("does not apply a split sibling's tab title to this pane", () => {
    const split: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
    }
    expect(onlyTarget(state(entry({}), ['pty-1'], 'Codex - action required', split))).toEqual({
      status: 'eligible',
      disabledReason: undefined
    })
    expect(
      onlyTarget(
        state(
          entry({ state: 'blocked', restoredUnconfirmed: true }),
          ['pty-1'],
          'Codex ready',
          split
        )
      )
    ).toEqual({ status: 'disabled', disabledReason: 'Agent needs permission' })
  })

  it('disables a pane whose saved PTY is not live', () => {
    expect(onlyTarget(state(entry({}), undefined))).toEqual({
      status: 'disabled',
      disabledReason: 'Terminal is no longer available'
    })
  })
})
