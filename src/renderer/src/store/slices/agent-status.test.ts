import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { flushMicrotasks } from './agent-status-test-harness'
import { createTestStore, makeTab, makeTabGroup, makeUnifiedTab } from './store-test-helpers'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status/agent-status-contract'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status/agent-status-drop-reducer'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
// Main answers the window's chat-tab commands and its frames draw them (switch-on builds).
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
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

    it('advances agentStatusEpoch when a fresh entry crosses the stale threshold', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests', agentType: 'codex' })

      expect(store.getState().agentStatusEpoch).toBe(1)

      await flushMicrotasks()

      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

      expect(store.getState().agentStatusEpoch).toBe(2)
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

    it('arms freshness expiry for status rows written by an external mirror', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))
      const store = createTestStore()
      const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
      const now = Date.now()

      store.setState({
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'Mirrored agent',
            updatedAt: now,
            stateStartedAt: now,
            stateHistory: []
          }
        }
      })
      store.getState().scheduleAgentStatusFreshness()
      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

      expect(store.getState().agentStatusEpoch).toBe(1)
    })
  })

  describe('agent status routing attribution', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('stores worktree and tab attribution from accepted hook events', () => {
      vi.useFakeTimers()
      const store = createTestStore()

      store
        .getState()
        .setAgentStatus(
          'tab-child:11111111-1111-4111-8111-111111111111',
          { state: 'working', prompt: 'child agent', agentType: 'codex' },
          undefined,
          undefined,
          { tabId: 'tab-child', worktreeId: 'wt-1', terminalHandle: 'term-child' }
        )

      expect(
        store.getState().agentStatusByPaneKey['tab-child:11111111-1111-4111-8111-111111111111']
      ).toMatchObject({
        tabId: 'tab-child',
        worktreeId: 'wt-1',
        terminalHandle: 'term-child'
      })
    })
  })

  describe('agent status stateStartedAt', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('carries stateStartedAt forward across same-state pings', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const store = createTestStore()
      store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1' }, 'claude')
      const firstStart = store.getState().agentStatusByPaneKey['tab-1:1'].stateStartedAt

      vi.setSystemTime(new Date('2026-04-09T12:00:05.000Z'))
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', toolName: 'Edit' }, 'claude')

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      // Same-state content pings advance updatedAt but must preserve true stateStartedAt.
      expect(entry.stateStartedAt).toBe(firstStart)
      expect(entry.updatedAt).toBe(new Date('2026-04-09T12:00:05.000Z').getTime())
    })

    it('resets stateStartedAt when the state changes', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const store = createTestStore()
      store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1' }, 'claude')
      const workingStart = store.getState().agentStatusByPaneKey['tab-1:1'].stateStartedAt

      vi.setSystemTime(new Date('2026-04-09T12:00:10.000Z'))
      store.getState().setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1' }, 'claude')

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.stateStartedAt).toBe(new Date('2026-04-09T12:00:10.000Z').getTime())
      expect(entry.stateStartedAt).not.toBe(workingStart)
      expect(entry.stateHistory).toHaveLength(1)
      expect(entry.stateHistory[0].state).toBe('working')
      expect(entry.stateHistory[0].startedAt).toBe(workingStart)
    })

    it('uses IPC snapshot timing instead of restamping restored entries as fresh', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(
          'tab-1:1',
          { state: 'working', prompt: 'p1', agentType: 'claude' },
          'claude',
          {
            updatedAt: new Date('2026-04-09T10:00:00.000Z').getTime(),
            stateStartedAt: new Date('2026-04-09T09:55:00.000Z').getTime()
          }
        )

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      expect(entry.updatedAt).toBe(new Date('2026-04-09T10:00:00.000Z').getTime())
      expect(entry.stateStartedAt).toBe(new Date('2026-04-09T09:55:00.000Z').getTime())
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

    it('on a live entry: removes it, writes a suppressor, and bumps both epochs', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })

      const agentEpochBefore = store.getState().agentStatusEpoch
      const sortEpochBefore = store.getState().sortEpoch

      store.getState().dropAgentStatus('tab-1:0')

      const s = store.getState()
      expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
      // User dismissal suppresses next retention pass or the row reappears.
      expect(s.retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
      expect(s.agentStatusEpoch).toBe(agentEpochBefore + 1)
      expect(s.sortEpoch).toBe(sortEpochBefore + 1)
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

    it('drops both live and retained entries when the same paneKey has both', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
      // Seed live+retained for one paneKey directly to exercise the combined dismissal branch.
      const now = Date.now()
      const retainedEntry: AgentStatusEntry = {
        state: 'done',
        prompt: '',
        updatedAt: now,
        stateStartedAt: now,
        paneKey: 'tab-1:0',
        stateHistory: []
      }
      const retained: RetainedAgentEntry = {
        entry: retainedEntry,
        worktreeId: 'wt-x',
        tab: { id: 'tab-1', title: 'claude' } as unknown as TerminalTab,
        agentType: 'claude',
        startedAt: now
      }
      store.getState().retainAgents([retained])

      expect(store.getState().agentStatusByPaneKey['tab-1:0']).toBeDefined()
      expect(store.getState().retainedAgentsByPaneKey['tab-1:0']).toBeDefined()

      const agentEpochBefore = store.getState().agentStatusEpoch
      const sortEpochBefore = store.getState().sortEpoch

      store.getState().dropAgentStatus('tab-1:0')

      const s = store.getState()
      expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
      expect(s.retainedAgentsByPaneKey['tab-1:0']).toBeUndefined()
      // Live+retained still needs a suppressor for its next disappearance, like live-only dismissal.
      expect(s.retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
      expect(s.agentStatusEpoch).toBe(agentEpochBefore + 1)
      expect(s.sortEpoch).toBe(sortEpochBefore + 1)
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

    it('on a paneKey with neither live nor retained entry: no-op (same state reference, no epoch bumps)', () => {
      vi.useFakeTimers()
      const store = createTestStore()

      const agentEpochBefore = store.getState().agentStatusEpoch
      const sortEpochBefore = store.getState().sortEpoch
      const suppressorsBefore = store.getState().retentionSuppressedPaneKeys
      const liveBefore = store.getState().agentStatusByPaneKey
      const retainedBefore = store.getState().retainedAgentsByPaneKey

      store.getState().dropAgentStatus('tab-missing:0')

      const s = store.getState()
      expect(s.agentStatusEpoch).toBe(agentEpochBefore)
      expect(s.sortEpoch).toBe(sortEpochBefore)
      // No-op must retain root identity or subscribed consumers rerender.
      expect(s.retentionSuppressedPaneKeys).toBe(suppressorsBefore)
      expect(s.agentStatusByPaneKey).toBe(liveBefore)
      expect(s.retainedAgentsByPaneKey).toBe(retainedBefore)
    })

    it('setAgentStatus clears a pending suppressor so the row can be retained normally on next disappearance', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
      store.getState().dropAgentStatus('tab-1:0')
      expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)

      store
        .getState()
        .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p2', agentType: 'claude' })

      // Fresh status lifts one-shot suppression so later real disappearance retains normally.
      expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBeUndefined()
    })

    it('clearRetentionSuppressedPaneKeys removes present keys and returns a new map; absent keys are no-op (identity preserved)', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
      store.getState().dropAgentStatus('tab-1:0')

      const suppressorsBefore = store.getState().retentionSuppressedPaneKeys
      expect(suppressorsBefore['tab-1:0']).toBe(true)

      store.getState().clearRetentionSuppressedPaneKeys(['tab-1:0'])
      const afterRemove = store.getState().retentionSuppressedPaneKeys
      expect(afterRemove['tab-1:0']).toBeUndefined()
      expect(afterRemove).not.toBe(suppressorsBefore)

      store.getState().clearRetentionSuppressedPaneKeys(['tab-does-not-exist:0'])
      const afterNoop = store.getState().retentionSuppressedPaneKeys
      // No-op suppressor clears must preserve record identity for selectors.
      expect(afterNoop).toBe(afterRemove)
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

    it('does not evict anything while under the cap', () => {
      const store = createTestStore()
      for (let i = 0; i < MAX_RETAINED_AGENTS; i++) {
        store.getState().retainAgents([makeRetained(i)])
      }
      const retained = store.getState().retainedAgentsByPaneKey
      expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
      expect(retained['tab-0:leaf-0']).toBeDefined()
    })

    it('re-retaining an existing paneKey overwrites in place and never grows the count', () => {
      const store = createTestStore()
      const first = makeRetained(0)
      store.getState().retainAgents([first])
      // Same paneKey, fresh snapshot (e.g. a later status update for the same pane).
      const updated = makeRetained(0)
      updated.entry.prompt = 'updated'
      store.getState().retainAgents([updated])

      const retained = store.getState().retainedAgentsByPaneKey
      expect(Object.keys(retained)).toHaveLength(1)
      expect(retained['tab-0:leaf-0'].entry.prompt).toBe('updated')
    })
  })
}
