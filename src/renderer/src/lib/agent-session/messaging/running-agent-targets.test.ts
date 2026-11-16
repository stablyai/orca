import { describe, expect, it } from 'vitest'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  deriveRunningAgentSendTargets,
  type RunningAgentTargetState
} from './running-agent-targets'

// Long before any test run, so every row is far past the old 30-minute status expiry.
const LONG_AGO = 1_700_000_000_000
const LEAF_ID = '0b9f6c1e-4a52-4d4f-9a55-1f3f6d2c7a10'
const SIBLING_LEAF_ID = '5d2a8e44-0c1b-4f7a-8b3e-9e6f1a2b3c4d'
const PANE_KEY = `tab-1:${LEAF_ID}`

function entry(
  overrides: Partial<Pick<AgentStatusEntry, 'state' | 'agentType' | 'restoredUnconfirmed'>>
): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: LONG_AGO,
    stateStartedAt: LONG_AGO,
    agentType: 'kiro',
    paneKey: PANE_KEY,
    stateHistory: [],
    ...overrides
  }
}

function state(
  statusEntry: AgentStatusEntry,
  livePtyIds: string[] | undefined,
  tabTitle = 'kiro-cli',
  root: TerminalPaneLayoutNode | null = null,
  guardedHosts: string[] = []
): RunningAgentTargetState {
  const ptyId = livePtyIds?.[0] ?? 'pty-1'
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
    agentStatusByPaneKey: acceptedAgentStatuses([[PANE_KEY, statusEntry]]),
    tabsByWorktree: { wt: [tab] },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        root,
        activeLeafId: root ? SIBLING_LEAF_ID : LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    },
    ptyIdsByTabId: livePtyIds === undefined ? {} : { 'tab-1': livePtyIds },
    runtimePaneTitlesByTabId: {},
    sendApprovalGuardEnvironmentIds: new Set(guardedHosts)
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

  it('disables a mid-turn Kiro pane, whose hooks report working through an approval menu', () => {
    expect(onlyTarget(state(entry({ state: 'working' }), ['pty-1']))).toEqual({
      status: 'disabled',
      disabledReason: 'Agent may be waiting for approval'
    })
    expect(onlyTarget(state(entry({ state: 'working', agentType: 'claude' }), ['pty-1']))).toEqual({
      status: 'eligible',
      disabledReason: undefined
    })
  })

  it('refuses a Kiro pane on a paired host whose send guard predates approval-hiding agents', () => {
    const remotePty = 'remote:host-1@@term-1'
    expect(onlyTarget(state(entry({}), [remotePty]))).toEqual({
      status: 'disabled',
      disabledReason: 'Update Orca on this host to send to this agent'
    })
    expect(onlyTarget(state(entry({}), [remotePty], 'kiro-cli', null, ['host-1']))).toEqual({
      status: 'eligible',
      disabledReason: undefined
    })
  })

  it('disables a pane whose saved PTY is not live', () => {
    expect(onlyTarget(state(entry({}), undefined))).toEqual({
      status: 'disabled',
      disabledReason: 'Terminal is no longer available'
    })
  })
})
