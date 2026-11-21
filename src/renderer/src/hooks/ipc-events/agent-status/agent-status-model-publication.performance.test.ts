import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { AcceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { resetAgentStatusEpochClockForTests } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import { selectPetAgentAnimation } from '@/components/pet/pet-agent-state'
import { getAgentSessionIdsKey } from '@/components/right-sidebar/ai-vault/scanning/ai-vault-agent-session-refresh-key'
import { getTerminalTabActivityFlags } from '@/components/tab-bar/terminal-tabs/terminal-tab-activity-status'
import {
  selectVisibleAgentOrchestration,
  visibleOrchestrationWorkForTest
} from '@/runtime/agent-orchestration/visible-agent-orchestration'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { createAgentStatusEventApplicator } from './agent-status-event-applicator'
import { createAgentStatusPaneRoutingIndex } from './agent-status-pane-routing-index'

const STARTED_AT = 1_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetAgentStatusEpochClockForTests()
})

it.each([100, 1000])(
  'publishes models for %s panes without scanning unrelated accepted rows',
  async (count) => {
    vi.useFakeTimers({ now: STARTED_AT, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const store = createTestStore()
    const worktrees = Array.from({ length: (count * 15) / 2 }, (_, index) =>
      makeWorktree({ id: `wt-${index}`, repoId: TEST_REPO.id, path: `/tmp/wt-${index}` })
    )
    const tabs = worktrees.slice(0, count).map((worktree, index): TerminalTab => ({
      id: `tab-${index}`,
      ptyId: null,
      worktreeId: worktree.id,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: STARTED_AT
    }))
    seedStore(store, {
      workspaceSessionReady: true,
      worktreesByRepo: { [TEST_REPO.id]: worktrees },
      tabsByWorktree: Object.fromEntries(tabs.map((tab) => [tab.worktreeId, [tab]])),
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((tab) => [
          tab.id,
          { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
        ])
      )
    })
    const rows = tabs.map((tab, index): AgentStatusIpcPayload => ({
      paneKey: makePaneKey(tab.id, LEAF),
      worktreeId: tab.worktreeId,
      tabId: tab.id,
      connectionId: null,
      state: 'working',
      agentType: 'antigravity',
      prompt: 'Task',
      receivedAt: STARTED_AT,
      evidenceObservedAt: STARTED_AT,
      stateStartedAt: STARTED_AT,
      providerSession: { key: 'conversation_id', id: `session-${index}` }
    }))
    const applyStatus = createAgentStatusEventApplicator({
      pendingAgentStatusEvents: [],
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus: () => {}
    })
    const publish = (events: AgentStatusIpcPayload[]) =>
      store.getState().transactAgentStatuses((transaction) => {
        const batch = {
          transaction,
          routingIndex: createAgentStatusPaneRoutingIndex(transaction.getState()),
          projectedTitlesByTabId: new Map(),
          tabTitlesByTabId: new Map(),
          notificationEffects: []
        }
        return events.map((event) => applyStatus(event, { batch }))
      })

    expect(publish(rows)).toEqual(Array(count).fill('applied'))
    expect(store.getState().agentStatusByPaneKey.size).toBe(count)
    const select = () => {
      const state = store.getState()
      return {
        flags: getTerminalTabActivityFlags(state.agentStatusByPaneKey, state.agentStatusEpoch),
        pet: selectPetAgentAnimation(state),
        sessions: getAgentSessionIdsKey(state.agentStatusByPaneKey),
        orchestration: selectVisibleAgentOrchestration(state)
      }
    }
    const initial = select()
    expect(initial.pet).toBe('running')
    expect(initial.flags.get('tab-0')?.hasLiveWorking).toBe(true)
    const routing = visibleOrchestrationWorkForTest()
    const entries = vi.spyOn(AcceptedAgentStatuses.prototype, 'entries')
    for (const row of rows) {
      expect(publish([{ ...row, model: 'resolved-model', isReplay: true }])).toEqual(['applied'])
      const next = select()
      expect(next.flags).toBe(initial.flags)
      expect(next.pet).toBe(initial.pet)
      expect(next.sessions).toBe(initial.sessions)
      expect(next.orchestration).toBe(initial.orchestration)
    }
    expect(entries).not.toHaveBeenCalled()
    expect(visibleOrchestrationWorkForTest()).toEqual(routing)
    expect(store.getState().agentStatusByPaneKey.get(rows.at(-1)!.paneKey)?.model).toBe(
      'resolved-model'
    )
    entries.mockRestore()

    const row = rows[0]!
    await vi.advanceTimersByTimeAsync(1)
    expect(
      publish([
        {
          ...row,
          model: 'resolved-model',
          state: 'waiting',
          receivedAt: STARTED_AT + 1,
          stateStartedAt: STARTED_AT + 1,
          evidenceObservedAt: STARTED_AT + 1,
          providerSession: { key: 'conversation_id', id: 'new-session' }
        }
      ])
    ).toEqual(['applied'])
    const waiting = select()
    expect(waiting.flags.get('tab-0')?.hasPermission).toBe(true)
    expect(waiting.pet).toBe('waiting')
    expect(waiting.sessions.split('\n')).toContain('new-session')
    expect(waiting.sessions.split('\n')).not.toContain('session-0')

    await vi.advanceTimersByTimeAsync(1_800_002)
    const stale = select()
    expect(stale.flags.get('tab-0')?.stalePaneIds.has(LEAF)).toBe(true)
    expect(stale.pet).toBe('idle')
    expect(stale.sessions).toBe(waiting.sessions)
  }
)
