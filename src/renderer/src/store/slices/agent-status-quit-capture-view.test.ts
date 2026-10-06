import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createAgentStatusRecoveryActions } from './agent-status-recovery-actions'
import type { AgentStatusRuntime } from './agent-status-runtime'

const LEAF = '11111111-1111-4111-8111-111111111111'
const WT = 'wt-1'
const TAB = 'tab-1'
const PANE = `${TAB}:${LEAF}`

function entry(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 5,
    stateStartedAt: 5,
    paneKey: PANE,
    tabId: TAB,
    worktreeId: WT,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    stateHistory: []
  }
}

function stateShowing(viewMode: 'chat' | 'terminal', sleeping: Record<string, unknown>): AppState {
  const tab = { id: TAB, worktreeId: WT, createdAt: 1, sortOrder: 0, viewMode }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scratch.
  return {
    tabsByWorktree: { [WT]: [{ ...tab, ptyId: 'p', title: 'A', customTitle: null, color: null }] },
    unifiedTabsByWorktree: {
      [WT]: [{ ...tab, entityId: TAB, groupId: 'g', contentType: 'terminal', label: 'A' }]
    },
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: { [PANE]: entry() },
    retainedAgentsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: sleeping
  } as unknown as AppState
}

function runQuit(state: AppState): AppState {
  let current = state
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: quit capture uses only set and clearSleepingAgentSessionsByPaneKey.
  const actions = createAgentStatusRecoveryActions({
    set: (fn: (s: AppState) => Partial<AppState>) => {
      const patch = fn(current)
      current = patch === current ? current : { ...current, ...patch }
    },
    clearSleepingAgentSessionsByPaneKey: () => {}
  } as unknown as AgentStatusRuntime)
  actions.captureAllSleepingAgentSessions('quit')
  return current
}

describe('quit capture after an aborted quit', () => {
  it('a second quit saves the view the pane shows now', () => {
    const first = runQuit(stateShowing('chat', {}))
    expect(first.sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      origin: 'quit',
      viewMode: 'chat'
    })
    // Quit aborted (dirty-file prompt cancelled); user switches the tab to terminal, quits again.
    const second = runQuit(stateShowing('terminal', first.sleepingAgentSessionsByPaneKey))
    expect(second.sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      origin: 'quit',
      viewMode: 'terminal'
    })
  })
})
