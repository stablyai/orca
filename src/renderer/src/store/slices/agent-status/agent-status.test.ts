import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import { createStoreSessionMockApi } from '../../testing/app-store-session-api.test-fixture'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status-contract'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-drop-reducer'
import { drawTabsFromMain } from '../tabs/tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/native-chat/tab-retirement/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
// Main answers the window's chat-tab commands and its frames draw them (switch-on builds).
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

/** Resolves `pending` under fake timers by running the timer ticks main's drain waits on (a 0 ms timer fires at 1 ms). */
async function underFakeTimers<T>(pending: Promise<T>): Promise<T> {
  let done = false
  void pending.finally(() => {
    done = true
  })
  for (let turn = 0; turn < 50 && !done; turn += 1) {
    await vi.advanceTimersByTimeAsync(1)
  }
  return pending
}

beforeEach(() => {
  // Track the original global before the shared fixture installs the renderer API.
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

{
  describe('agent status stateStartedAt', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ignores an older snapshot when a newer live event already updated the pane', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'fresh', agentType: 'claude' },
          'claude',
          { updatedAt: 2_000, stateStartedAt: 2_000 }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'done', prompt: 'stale', agentType: 'claude' },
          'claude',
          { updatedAt: 1_000, stateStartedAt: 1_000 }
        )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.state).toBe('working')
      expect(entry.prompt).toBe('fresh')
      expect(entry.updatedAt).toBe(2_000)
    })
  })
}

{
  describe('dropAgentStatus + retention suppressor', () => {
    // Use fake timers for microtask-scheduled 30-minute freshness timeouts.
    afterEach(() => {
      vi.useRealTimers()
    })

    it('removes a retained-only entry', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      const now = Date.now()
      const entry: AgentStatusEntry = {
        state: 'done',
        prompt: '',
        updatedAt: now,
        stateStartedAt: now,
        paneKey: 'tab-retained:0',
        stateHistory: []
      }
      const retained: RetainedAgentEntry = {
        entry,
        worktreeId: 'wt-x',
        tab: { id: 'tab-retained', title: 'claude' } as unknown as TerminalTab,
        agentType: 'claude',
        startedAt: now
      }
      store.getState().retainAgents([retained])

      store.getState().dropAgentStatus('tab-retained:0')

      const s = store.getState()
      expect(s.retainedAgentsByPaneKey['tab-retained:0']).toBeUndefined()
    })

    it('closeTab drops completed worktree-attributed orphan rows', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [
            makeTab({ id: 'tab-closed', worktreeId: 'wt-1' }),
            makeTab({ id: 'tab-live', worktreeId: 'wt-1' })
          ],
          'wt-2': []
        },
        unifiedTabsByWorktree: {
          'wt-1': [makeUnifiedTab({ id: 'tab-orphan', worktreeId: 'wt-1', groupId: 'group-1' })]
        }
      })
      store
        .getState()
        .setAgentStatus('tab-closed:0', { state: 'done', prompt: 'closed', agentType: 'pi' })
      store
        .getState()
        .setAgentStatus(
          'tab-orphan:0',
          { state: 'done', prompt: 'orphan', agentType: 'pi' },
          undefined,
          undefined,
          { worktreeId: 'wt-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-active-child:0',
          { state: 'working', prompt: 'active child', agentType: 'pi' },
          undefined,
          undefined,
          { worktreeId: 'wt-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-live:0',
          { state: 'done', prompt: 'open tab', agentType: 'pi' },
          undefined,
          undefined,
          { worktreeId: 'wt-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-other-orphan:0',
          { state: 'done', prompt: 'other worktree', agentType: 'pi' },
          undefined,
          undefined,
          { worktreeId: 'wt-2' }
        )

      store.getState().closeTab('tab-closed')

      const s = store.getState()
      expect(s.tabsByWorktree['wt-1']?.some((tab) => tab.id === 'tab-closed')).toBe(false)
      expect(s.agentStatusByPaneKey['tab-closed:0']).toBeUndefined()
      expect(s.agentStatusByPaneKey['tab-orphan:0']).toBeUndefined()
    })

    it.each(['wt-1', 'folder-workspace-1'])(
      'preserves an open chat and its read state when an unrelated terminal closes in %s',
      async (worktreeId) => {
        vi.useFakeTimers()
        const store = createTestStore()
        const sessionId = 'chat-1'
        const chat = makeUnifiedTab({
          id: structuredAgentSessionTabId(sessionId),
          entityId: sessionId,
          contentType: 'agent-session',
          executionHostId: 'local',
          worktreeId,
          groupId: 'group-1'
        })
        const paneKey = structuredAgentSessionPaneKey(chat.id, sessionId)
        const missingOwnerPaneKey = structuredAgentSessionPaneKey(
          structuredAgentSessionTabId('missing-chat'),
          'missing-chat'
        )
        store.setState({
          tabsByWorktree: {
            [worktreeId]: [
              makeTab({ id: 'tab-closed', worktreeId }),
              makeTab({ id: 'tab-live', worktreeId })
            ]
          },
          unifiedTabsByWorktree: { [worktreeId]: [chat] },
          groupsByWorktree: {
            [worktreeId]: [
              makeTabGroup({
                id: 'group-1',
                worktreeId,
                activeTabId: chat.id,
                tabOrder: [chat.id]
              })
            ]
          },
          layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId: 'group-1' } },
          activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
        })
        for (const key of [paneKey, missingOwnerPaneKey]) {
          store
            .getState()
            .setAgentStatus(
              key,
              { state: 'done', prompt: 'completed chat', agentType: 'codex' },
              undefined,
              undefined,
              { worktreeId }
            )
        }
        store.getState().acknowledgeAgents([paneKey, missingOwnerPaneKey])
        store.setState({
          activityClearedAtByPaneKey: { [paneKey]: 100, [missingOwnerPaneKey]: 100 },
          manuallyUnreadTurnsByPaneKey: { [paneKey]: 200, [missingOwnerPaneKey]: 200 }
        })
        const main = await underFakeTimers(drawTabsFromMain(store))

        store.getState().closeTab('tab-closed')

        const after = store.getState()

        expect(after.activityClearedAtByPaneKey[paneKey]).toBe(100)
        expect(after.manuallyUnreadTurnsByPaneKey[paneKey]).toBe(200)
        expect(after.agentStatusByPaneKey[missingOwnerPaneKey]).toBeUndefined()
        expect(after.acknowledgedAgentsByPaneKey[missingOwnerPaneKey]).toBeUndefined()
        expect(after.activityClearedAtByPaneKey[missingOwnerPaneKey]).toBeUndefined()
        expect(after.manuallyUnreadTurnsByPaneKey[missingOwnerPaneKey]).toBeUndefined()

        store.getState().closeUnifiedTab(chat.id)
        await underFakeTimers(main.settle())
        store.getState().closeTab('tab-live')
        main.close()

        const closed = store.getState()
        expect(closed.unifiedTabsByWorktree[worktreeId]).toEqual([])
        expect(closed.agentStatusByPaneKey[paneKey]).toBeUndefined()
        expect(closed.acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()
        expect(closed.activityClearedAtByPaneKey[paneKey]).toBeUndefined()
        expect(closed.manuallyUnreadTurnsByPaneKey[paneKey]).toBeUndefined()
      }
    )

    it('keeps an exact-pane remote retirement scoped to that pane', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      const retiringPaneKey = 'host-tab:11111111-1111-4111-8111-111111111111'
      const siblingPaneKey = 'host-tab:22222222-2222-4222-8222-222222222222'
      for (const paneKey of [retiringPaneKey, siblingPaneKey, 'missing-owner:0']) {
        store
          .getState()
          .setAgentStatus(
            paneKey,
            { state: 'done', prompt: 'remote chat', agentType: 'codex' },
            undefined,
            undefined,
            { worktreeId: 'wt-1' }
          )
      }
      const before = store.getState()

      const { patch } = buildAgentStatusTabPrefixDropPatch(before, 'host-tab', [], {
        worktreeId: 'wt-1',
        paneKeys: new Set([retiringPaneKey])
      })

      expect(patch.agentStatusByPaneKey?.[retiringPaneKey]).toBeUndefined()
    })
  })
}
