import { describe, expect, it } from 'vitest'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
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
})
