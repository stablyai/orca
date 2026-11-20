import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import { projectStatus } from './structured-agent-session-status-projection'
import type { StructuredTab } from './structured-agent-session-tabs'

const WORKSPACE_ID = 'folder:bot-home-1'
const SESSION_ID = 'bot-session-1'
const TAB_ID = structuredAgentSessionTabId(SESSION_ID)
const PANE_KEY = structuredAgentSessionPaneKey(TAB_ID, SESSION_ID)
const TURN_AT = 1_795_179_838_842

const BOT_TAB: StructuredTab = {
  id: TAB_ID,
  entityId: SESSION_ID,
  groupId: 'group-1',
  worktreeId: WORKSPACE_ID,
  contentType: 'agent-session',
  agentSessionAgent: 'omp',
  label: 'Bot chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: TURN_AT - 10_000
}

const COMPLETED_SUMMARY: AgentSessionStatusSummary = {
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  agent: 'omp',
  status: 'idle',
  turnOutcome: 'success',
  statusStartedAt: TURN_AT,
  latestPrompt: 'Finish task',
  runtimePermission: null,
  updatedAt: TURN_AT
}

describe('structured agent session activity clear persistence', () => {
  it('preserves activity clear and read cutoffs across null-summary projection and later replay', () => {
    const store = createTestStore()
    store.getState().transactAgentStatuses((transaction) => {
      projectStatus(transaction, BOT_TAB, COMPLETED_SUMMARY, 'live', null)
    })
    store.getState().applyActivityClearedAt({ [PANE_KEY]: TURN_AT })
    store.getState().acknowledgeAgents([PANE_KEY])
    const ackAt = store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]

    // Before the status feed snapshot arrives on restart, summary is null and clears the live row.
    store.getState().transactAgentStatuses((transaction) => {
      projectStatus(transaction, BOT_TAB, null, 'unverifiable', null)
    })

    expect(store.getState().agentStatusByPaneKey.get(PANE_KEY)).toBeUndefined()
    expect(store.getState().activityClearedAtByPaneKey[PANE_KEY]).toBe(TURN_AT)
    expect(store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBe(ackAt)

    // Replaying the same completed turn keeps the saved clear cutoff intact.
    store.getState().transactAgentStatuses((transaction) => {
      projectStatus(transaction, BOT_TAB, COMPLETED_SUMMARY, 'live', null)
    })

    expect(store.getState().agentStatusByPaneKey.get(PANE_KEY)?.stateStartedAt).toBe(TURN_AT)
    expect(store.getState().activityClearedAtByPaneKey[PANE_KEY]).toBe(TURN_AT)
  })
})
