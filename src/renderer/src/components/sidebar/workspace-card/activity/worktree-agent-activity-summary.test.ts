import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/tab-types'

import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
  worktreeId?: string
  parentPaneKey?: string
  restoredUnconfirmed?: true
  workingMode?: AgentStatusEntry['workingMode']
  interrupted?: true
  mainAgent?: AgentStatusEntry['mainAgent']
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    worktreeId: args.worktreeId,
    restoredUnconfirmed: args.restoredUnconfirmed,
    workingMode: args.workingMode,
    interrupted: args.interrupted,
    mainAgent: args.mainAgent,
    orchestration: args.parentPaneKey
      ? {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey: args.parentPaneKey
        }
      : undefined
  }
}

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('selectWorktreeAgentActivitySummary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('updates when a represented chat arrives after its status without changing other inputs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const worktreeId = 'repo::/wt-1'
    const tab: Tab = {
      id: 'restored:chat',
      entityId: 'session-1',
      worktreeId,
      groupId: 'group-1',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      agentStatusEpoch: 0,
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [paneKey]: makeAgentStatusEntry({ paneKey, worktreeId, state: 'working' })
        })
      ),
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {}
    })

    expect(selectWorktreeAgentActivitySummary(store.getState(), worktreeId).hasLiveWorking).toBe(
      false
    )
    store.setState({ unifiedTabsByWorktree: { [worktreeId]: [tab] } })
    expect(selectWorktreeAgentActivitySummary(store.getState(), worktreeId).hasLiveWorking).toBe(
      true
    )
    store.setState({ unifiedTabsByWorktree: {} })
    expect(selectWorktreeAgentActivitySummary(store.getState(), worktreeId).hasLiveWorking).toBe(
      false
    )
  })

  it('reports current pane membership and preserves an explicitly captured summary', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const worktreeId = 'repo::/wt-1'
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const secondPaneKey = makePaneKey('tab-2', LEAF_ID)
    const replacementPaneKey = makePaneKey('tab-3', LEAF_ID)
    const sharedInputs = {
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {}
    }
    const store = createTestStore()
    store.setState({
      ...sharedInputs,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId), makeTab('tab-2', worktreeId)]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [firstPaneKey]: makeAgentStatusEntry({ paneKey: firstPaneKey, state: 'working' }),
          [secondPaneKey]: makeAgentStatusEntry({ paneKey: secondPaneKey, state: 'working' })
        })
      )
    })
    expect(
      selectWorktreeAgentActivitySummary(store.getState(), worktreeId).agentStatusPaneIdsByTabId
    ).toEqual({
      'tab-1': new Set([LEAF_ID]),
      'tab-2': new Set([LEAF_ID])
    })
    store.setState({
      ...sharedInputs,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-3', worktreeId)] },
      agentStatusEpoch: 2,
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [replacementPaneKey]: makeAgentStatusEntry({
            paneKey: replacementPaneKey,
            state: 'working'
          })
        })
      )
    })
    const afterReplacement = selectWorktreeAgentActivitySummary(store.getState(), worktreeId)
    expect(afterReplacement.agentStatusPaneIdsByTabId).toEqual({ 'tab-3': new Set([LEAF_ID]) })
    const captured = store.getState().agentStatusByPaneKey.capture()
    store.setState({
      agentStatusEpoch: 3,
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({}))
    })
    const afterRemoval = selectWorktreeAgentActivitySummary(store.getState(), worktreeId)

    expect(captured.projection.summary(worktreeId).agentStatusPaneIdsByTabId).toEqual({
      'tab-3': new Set([LEAF_ID])
    })
    expect(afterRemoval).toMatchObject({ hasLiveWorking: false })
    expect(afterRemoval.agentStatusPaneIdsByTabId).toEqual({})
  })

  // Retain stale pane identity so Orca’s generated permission title cannot outlive its authoritative row.
  it('records a stale entry pane id separately so permission titles stay suppressed', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const entry = makeAgentStatusEntry({ paneKey, state: 'done', worktreeId: 'repo::/wt-1' })
    vi.spyOn(Date, 'now').mockReturnValue(entry.updatedAt + AGENT_STATUS_STALE_AFTER_MS + 1)
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')] },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [paneKey]: entry })),
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {}
    })

    const summary = selectWorktreeAgentActivitySummary(store.getState(), 'repo::/wt-1')

    expect(summary.stalePaneIdsByTabId['tab-1']).toEqual(new Set([LEAF_ID]))
    // Staleness still ends the row's authority: no fresh pane id, no liveness flag.
    expect(summary.agentStatusPaneIdsByTabId['tab-1']).toBeUndefined()
    expect(summary.hasLiveDone).toBe(false)
  })
})
