import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { collectSleepingAgentSessionRecordsForWorktree } from './agent-status-recovery-collection'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'

const LEAF = '11111111-1111-4111-8111-111111111111'
const WT = 'wt-1'
const TAB = 'tab-1'
const PANE = `${TAB}:${LEAF}`

function entry(agentType: string): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 5,
    stateStartedAt: 5,
    paneKey: PANE,
    tabId: TAB,
    worktreeId: WT,
    agentType,
    providerSession: { key: 'session_id', id: 'sess-1' },
    stateHistory: []
  }
}

function stateShowing(
  viewMode: 'chat' | 'terminal',
  live: AgentStatusEntry | null,
  sleeping: Record<string, unknown> = {}
): AppState {
  const tab = { id: TAB, worktreeId: WT, createdAt: 1, sortOrder: 0, viewMode }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these slices.
  return {
    tabsByWorktree: { [WT]: [{ ...tab, ptyId: 'p', title: 'A', customTitle: null, color: null }] },
    unifiedTabsByWorktree: {
      [WT]: [{ ...tab, entityId: TAB, groupId: 'g', contentType: 'terminal', label: 'A' }]
    },
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: live ? { [PANE]: live } : {},
    retainedAgentsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: sleeping
  } as unknown as AppState
}

describe('Agent Sleep reads the view when a record becomes durable', () => {
  it('keeps no view on a live checkpoint, which only status events rebuild', () => {
    const record = sleepingRecordFromEntry({
      state: stateShowing('chat', null),
      entry: entry('claude'),
      worktreeId: WT,
      capturedAt: 5,
      origin: 'live'
    })
    expect(record).not.toHaveProperty('viewMode')
  })

  it.each([
    ['omp', true],
    ['claude', false]
  ] as const)(
    'a manual sleep promoting a %s checkpoint saves the view the pane shows now (status row: %s)',
    (agent, withStatusRow) => {
      const checkpoint = sleepingRecordFromEntry({
        state: stateShowing('chat', entry(agent)),
        entry: entry(agent),
        worktreeId: WT,
        capturedAt: 5,
        origin: 'live'
      })
      // The user switched the tab to terminal with no status event, then slept the workspace.
      const state = stateShowing('terminal', withStatusRow ? entry(agent) : null, {
        [PANE]: checkpoint
      })
      const records = collectSleepingAgentSessionRecordsForWorktree(state, WT, {
        captureMode: 'manual-worktree-sleep'
      })
      expect(records[PANE]).toMatchObject({ origin: 'worktree-sleep', viewMode: 'terminal' })
    }
  )
})
