import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'

// Why: split out from agent-status.test.ts to keep each file under the
// repo's 300-line cap for test files. This suite covers the new
// user-dismissal paths (dropAgentStatus, retentionSuppressedPaneKeys,
// clearRetentionSuppressedPaneKeys) introduced alongside the dashboard.

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
