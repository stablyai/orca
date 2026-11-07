import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { flushMicrotasks } from './agent-status-test-harness'
import { createTestStore } from '../store-test-helpers'
import {
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  createStoreSessionMockApi
} from '../store-session-test-harness'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status-contract'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-drop-reducer'
import { drawTabsFromMain } from '../tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
// Main answers the window's chat-tab commands and its frames draw them (switch-on builds).
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
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
  describe('agent status freshness expiry', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('cancels the scheduled freshness tick when the entry is removed first', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests', agentType: 'codex' })
      store.getState().removeAgentStatus('tab-1:1')
      expect(store.getState().agentStatusEpoch).toBe(2)

      await flushMicrotasks()
      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

      expect(store.getState().agentStatusEpoch).toBe(2)
    })
  })

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

    it('on a retained-only entry: removes retained row but does NOT write a suppressor and does NOT bump agentStatusEpoch', () => {
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

      const agentEpochBefore = store.getState().agentStatusEpoch
      const sortEpochBefore = store.getState().sortEpoch

      store.getState().dropAgentStatus('tab-retained:0')

      const s = store.getState()
      expect(s.retainedAgentsByPaneKey['tab-retained:0']).toBeUndefined()
      // Only live→gone consumes suppressors; retained-only dismissal must not plant a permanent leak.
      expect(s.retentionSuppressedPaneKeys['tab-retained:0']).toBeUndefined()
      expect(s.agentStatusEpoch).toBe(agentEpochBefore)
      expect(s.sortEpoch).toBe(sortEpochBefore)
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
      // Orphan tab has no retention transition to consume a suppressor; skip planting it.
      expect(s.retentionSuppressedPaneKeys['tab-orphan:0']).toBeUndefined()
      expect(s.agentStatusByPaneKey['tab-active-child:0']).toBeDefined()
      expect(s.agentStatusByPaneKey['tab-live:0']).toBeDefined()
      expect(s.agentStatusByPaneKey['tab-other-orphan:0']).toBeDefined()
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
        const before = store.getState()

        store.getState().closeTab('tab-closed')

        const after = store.getState()
        expect(after.agentStatusByPaneKey[paneKey]).toBe(before.agentStatusByPaneKey[paneKey])
        expect(after.acknowledgedAgentsByPaneKey[paneKey]).toBe(
          before.acknowledgedAgentsByPaneKey[paneKey]
        )
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
      expect(patch.agentStatusByPaneKey?.[siblingPaneKey]).toBe(
        before.agentStatusByPaneKey[siblingPaneKey]
      )
      expect(patch.agentStatusByPaneKey?.['missing-owner:0']).toBe(
        before.agentStatusByPaneKey['missing-owner:0']
      )
    })
  })
}

{
  /** Bound retained snapshots by MAX_RETAINED_AGENTS, evicting oldest insertions. Ephemeral pane keys accumulate large messages/prompts/history/tab records during long orchestration sessions; worktree removal/user dismissal alone cannot prevent renderer OOM. */

  // MAX_RETAINED_AGENTS is module-private; mirror its value here.
  const MAX_RETAINED_AGENTS = 500

  // Use near-maximum production payloads so assertions expose leaked byte weight, not just count.
  const BIG_ASSISTANT_MESSAGE = 'a'.repeat(8 * 1024)
  const BIG_INTERACTIVE_PROMPT = 'q'.repeat(16 * 1024)

  function makeRetained(index: number, worktreeId = 'wt-x'): RetainedAgentEntry {
    const paneKey = `tab-${index}:leaf-${index}`
    const entry: AgentStatusEntry = {
      state: 'done',
      prompt: `prompt ${index}`,
      updatedAt: index,
      stateStartedAt: index,
      paneKey,
      stateHistory: [],
      lastAssistantMessage: BIG_ASSISTANT_MESSAGE,
      interactivePrompt: BIG_INTERACTIVE_PROMPT
    }
    return {
      entry,
      worktreeId,
      tab: { id: `tab-${index}`, title: 'claude' } as unknown as TerminalTab,
      agentType: 'claude',
      startedAt: index
    }
  }

  describe('retainedAgentsByPaneKey stays bounded (leak regression)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('caps retainedAgentsByPaneKey and keeps the most recently retained keys', () => {
      const store = createTestStore()

      const total = MAX_RETAINED_AGENTS + 200
      for (let i = 0; i < total; i++) {
        store.getState().retainAgents([makeRetained(i)])
      }

      const retained = store.getState().retainedAgentsByPaneKey
      expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)

      expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
      expect(retained['tab-0:leaf-0']).toBeUndefined()
      expect(
        retained[`tab-${total - MAX_RETAINED_AGENTS - 1}:leaf-${total - MAX_RETAINED_AGENTS - 1}`]
      ).toBeUndefined()
      expect(
        retained[`tab-${total - MAX_RETAINED_AGENTS}:leaf-${total - MAX_RETAINED_AGENTS}`]
      ).toBeDefined()
    })

    it('caps even when many completions are retained in a single batch', () => {
      const store = createTestStore()
      const total = MAX_RETAINED_AGENTS + 50
      const batch = Array.from({ length: total }, (_, i) => makeRetained(i))

      store.getState().retainAgents(batch)

      const retained = store.getState().retainedAgentsByPaneKey
      expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
      expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
      expect(retained['tab-0:leaf-0']).toBeUndefined()
    })
  })
}
