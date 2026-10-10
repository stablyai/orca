import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { flushMicrotasks } from './agent-status-test-harness'
import { createTestStore, makeTab } from './store-test-helpers'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status'

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

      // setAgentStatus bumps epoch once synchronously
      expect(store.getState().agentStatusEpoch).toBe(1)

      // Flush the queueMicrotask that schedules the freshness timer
      await flushMicrotasks()

      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

      // Timer bump adds another increment
      expect(store.getState().agentStatusEpoch).toBe(2)
    })

    it('cancels the scheduled freshness tick when the entry is removed first', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const store = createTestStore()
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests', agentType: 'codex' })
      // set bumps to 1, remove bumps to 2
      store.getState().removeAgentStatus('tab-1:1')
      expect(store.getState().agentStatusEpoch).toBe(2)

      // Flush microtask and advance past stale threshold
      await flushMicrotasks()
      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

      // No additional bump since the entry was removed before the timer fires
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

      // Advance 5s and re-ping with same state but different prompt/tool fields
      vi.setSystemTime(new Date('2026-04-09T12:00:05.000Z'))
      store
        .getState()
        .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', toolName: 'Edit' }, 'claude')

      const entry = store.getState().agentStatusByPaneKey['tab-1:1']
      // Why: stateStartedAt is the invariant we are protecting — it must survive
      // tool/prompt pings within the same state, while updatedAt advances.
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
      // history should capture the working state's true start
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
    // Why: setAgentStatus schedules a real 30-minute freshness setTimeout via
    // queueMicrotask. Use fake timers so the handle does not leak into the
    // test process (see agent-status.ts line 90).
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
      // Why: user-initiated dismissal must plant a one-shot suppressor so the
      // retention sync does not resurrect the row on the next render frame.
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
      // Why: the suppressor is consumed by collectRetainedAgentsOnDisappear,
      // which only runs on live→gone transitions. A retained-only dismissal has
      // no live entry to disappear, so writing a suppressor would leak forever.
      expect(s.retentionSuppressedPaneKeys['tab-retained:0']).toBeUndefined()
      // Why: hasLive is false, so no epoch bumps.
      expect(s.agentStatusEpoch).toBe(agentEpochBefore)
      expect(s.sortEpoch).toBe(sortEpochBefore)
    })

    it('drops both live and retained entries when the same paneKey has both', () => {
      vi.useFakeTimers()
      const store = createTestStore()
      // Seed a live entry first.
      store
        .getState()
        .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
      // Seed a retained entry for the SAME paneKey. The retainAgents path is
      // what the production retention sync calls on live→gone transitions; here
      // we invoke it directly to construct the "both live AND retained for the
      // same paneKey" state that the dropAgentStatus hasLive+hasRetained branch
      // (agent-status.ts lines 301-311) handles.
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

      // Sanity-check the precondition: both maps carry the paneKey.
      expect(store.getState().agentStatusByPaneKey['tab-1:0']).toBeDefined()
      expect(store.getState().retainedAgentsByPaneKey['tab-1:0']).toBeDefined()

      const agentEpochBefore = store.getState().agentStatusEpoch
      const sortEpochBefore = store.getState().sortEpoch

      store.getState().dropAgentStatus('tab-1:0')

      const s = store.getState()
      // Both maps drop the paneKey in the combined branch.
      expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
      expect(s.retainedAgentsByPaneKey['tab-1:0']).toBeUndefined()
      // Why: hasLive=true, so the suppressor IS planted (mirrors the live-only
      // test above). The concurrent retained entry does not change that logic —
      // the live→gone transition on the next frame still needs to be suppressed.
      expect(s.retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
      // Why: hasLive=true means both epochs bump in lockstep (same rationale
      // as the live-only case).
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
      // No suppressor for the orphan: its tab is already gone, so retention sync
      // never re-surfaces it and a suppressor would leak permanently.
      expect(s.retentionSuppressedPaneKeys['tab-orphan:0']).toBeUndefined()
      expect(s.agentStatusByPaneKey['tab-active-child:0']).toBeDefined()
      expect(s.agentStatusByPaneKey['tab-live:0']).toBeDefined()
      expect(s.agentStatusByPaneKey['tab-other-orphan:0']).toBeDefined()
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
      // Why: the short-circuit `return s` must preserve object identity so
      // consumers selecting on these slices do not re-render spuriously.
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

      // Why: a new status event means the agent is live again — the one-shot
      // suppressor must lift so the next disappearance can retain normally.
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

      // Present-key removal: new map reference, key gone.
      store.getState().clearRetentionSuppressedPaneKeys(['tab-1:0'])
      const afterRemove = store.getState().retentionSuppressedPaneKeys
      expect(afterRemove['tab-1:0']).toBeUndefined()
      expect(afterRemove).not.toBe(suppressorsBefore)

      // Absent-key clear: no-op, same object reference.
      store.getState().clearRetentionSuppressedPaneKeys(['tab-does-not-exist:0'])
      const afterNoop = store.getState().retentionSuppressedPaneKeys
      // Why: preserving object identity on no-op clears avoids spurious
      // re-renders in any selector subscribed to retentionSuppressedPaneKeys.
      expect(afterNoop).toBe(afterRemove)
    })
  })
}

{
  /**
   * Memory-leak regression: retainedAgentsByPaneKey must stay bounded.
   *
   * `retainedAgentsByPaneKey` is a Record keyed by ephemeral paneKey
   * (`${tabId}:${leafId}`, where leafId is a fresh UUID minted per pane and never
   * reused). Every agent that finishes and then vanishes from the live map is
   * snapshotted here via `retainAgents`. Each snapshot is a full RetainedAgentEntry
   * — an AgentStatusEntry (which carries an up-to-8KB lastAssistantMessage, an
   * up-to-16KB interactivePrompt, a prompt, and up to 20 stateHistory rows) plus a
   * full TerminalTab snapshot.
   *
   * Before the fix, `retainAgents` only ever wrote entries and never capped them,
   * so the map grew monotonically with the number of distinct completed-agent
   * paneKeys observed. The only removal paths are worktree removal
   * (`pruneRetainedAgents`) and explicit user dismissal — neither of which runs
   * while a long-lived worktree stays open. Under a multi-hour multi-agent /
   * orchestration session (sub-agents complete continuously), this large-payload
   * accumulator is the dominant driver of the renderer JS-heap OOM seen in the
   * Windows crash bundles (heap climbing to the 3586 MB old-space limit).
   *
   * The fix caps it to MAX_RETAINED_AGENTS, evicting the oldest-retained keys
   * (insertion order == retention order, so the newest completions survive).
   */

  // MAX_RETAINED_AGENTS is module-private; mirror its value here.
  const MAX_RETAINED_AGENTS = 500

  // Approximate the worst-case per-entry payload the production type permits, so
  // the leak's byte weight (not just entry count) is visible in the assertions.
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

      // Drive the production retention path with more distinct ephemeral paneKeys
      // than the cap allows — one call per completion, as production does.
      const total = MAX_RETAINED_AGENTS + 200
      for (let i = 0; i < total; i++) {
        store.getState().retainAgents([makeRetained(i)])
      }

      const retained = store.getState().retainedAgentsByPaneKey
      // Bounded — not `total`. Without the cap this is MAX_RETAINED_AGENTS + 200.
      expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)

      // The newest completions survive; the oldest are evicted.
      expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
      expect(retained['tab-0:leaf-0']).toBeUndefined()
      // The exact eviction boundary: everything before (total - cap) is gone.
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
