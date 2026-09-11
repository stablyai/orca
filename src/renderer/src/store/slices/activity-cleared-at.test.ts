import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'
import {
  sanitizeAcknowledgedAgentsByPaneKey,
  sanitizeActivityClearedAtByPaneKey
} from './ui/ui-slice-hydration-sanitizers'

function makeRetained(paneKey: string, worktreeId = 'wt-1'): RetainedAgentEntry {
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'run',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    paneKey,
    stateHistory: [],
    agentType: 'claude'
  }
  const tab: TerminalTab = {
    id: paneKey.split(':')[0],
    ptyId: 'pty-1',
    worktreeId,
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return { entry, worktreeId, tab, agentType: 'claude', startedAt: 1_000 }
}

describe('applyActivityClearedAt', () => {
  it('merges stamps, deletes on null, and no-ops on identical patches', () => {
    const store = createTestStore()
    store.getState().applyActivityClearedAt({ 'a:1': 100, 'b:2': 200 })
    expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'a:1': 100, 'b:2': 200 })

    const before = store.getState().activityClearedAtByPaneKey
    store.getState().applyActivityClearedAt({ 'a:1': 100 })
    // Identity preserved when nothing changed, so subscribers don't churn.
    expect(store.getState().activityClearedAtByPaneKey).toBe(before)

    store.getState().applyActivityClearedAt({ 'a:1': null })
    expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'b:2': 200 })

    const afterDelete = store.getState().activityClearedAtByPaneKey
    store.getState().applyActivityClearedAt({ missing: null })
    expect(store.getState().activityClearedAtByPaneKey).toBe(afterDelete)
  })
})

describe('dismissRetainedAgents', () => {
  it('removes the named retained entries in one update and leaves others intact', () => {
    const store = createTestStore()
    store
      .getState()
      .retainAgents([makeRetained('tab-a:1'), makeRetained('tab-b:2'), makeRetained('tab-c:3')])
    store.getState().dismissRetainedAgents(['tab-a:1', 'tab-c:3', 'tab-unknown:9'])
    expect(Object.keys(store.getState().retainedAgentsByPaneKey)).toEqual(['tab-b:2'])
  })

  it('plants a retention suppressor only for panes that still have a live entry', () => {
    const store = createTestStore()
    store.getState().retainAgents([makeRetained('tab-a:1'), makeRetained('tab-b:2')])
    store.setState({
      agentStatusByPaneKey: {
        'tab-a:1': {
          state: 'done',
          prompt: 'live',
          updatedAt: 2_000,
          stateStartedAt: 2_000,
          paneKey: 'tab-a:1',
          stateHistory: [],
          agentType: 'claude'
        }
      }
    })
    store.getState().dismissRetainedAgents(['tab-a:1', 'tab-b:2'])
    expect(store.getState().retainedAgentsByPaneKey).toEqual({})
    // Live pane gets a one-shot suppressor; the gone pane must NOT (undo re-retains it cleanly).
    expect(store.getState().retentionSuppressedPaneKeys['tab-a:1']).toBe(true)
    expect(store.getState().retentionSuppressedPaneKeys['tab-b:2']).toBeUndefined()
  })

  it('no-ops without reallocation when nothing matches', () => {
    const store = createTestStore()
    store.getState().retainAgents([makeRetained('tab-a:1')])
    const before = store.getState().retainedAgentsByPaneKey
    store.getState().dismissRetainedAgents(['tab-zz:9'])
    expect(store.getState().retainedAgentsByPaneKey).toBe(before)
  })
})

describe('dropAgentStatus cleared-at/manual-unread lifecycle', () => {
  // Why: setAgentStatus schedules a real 30-minute freshness setTimeout.
  afterEach(() => {
    vi.useRealTimers()
  })

  function seedLiveWithClearState(store: ReturnType<typeof createTestStore>): void {
    vi.useFakeTimers()
    store.getState().setAgentStatus('tab-a:1', { state: 'done', prompt: 'p', agentType: 'claude' })
    store.getState().applyActivityClearedAt({ 'tab-a:1': 5_000 })
    store.getState().unacknowledgeAgents(['tab-a:1'])
    expect(store.getState().activityClearedAtByPaneKey['tab-a:1']).toBe(5_000)
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-a:1']).toBeGreaterThan(0)
  }

  it('row dismissal keeps the cutoff and manual-unread stamp for a still-live pane', () => {
    const store = createTestStore()
    seedLiveWithClearState(store)
    store.getState().dropAgentStatus('tab-a:1')
    expect(store.getState().agentStatusByPaneKey['tab-a:1']).toBeUndefined()
    // The pane may republish its full stateHistory; without the cutoff every
    // cleared event would flood back as unread (the Clear-completed undo bug).
    expect(store.getState().activityClearedAtByPaneKey['tab-a:1']).toBe(5_000)
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-a:1']).toBeGreaterThan(0)
  })

  it('paneRemoved drop clears the cutoff and manual-unread stamp with the pane', () => {
    const store = createTestStore()
    seedLiveWithClearState(store)
    store.getState().dropAgentStatus('tab-a:1', { paneRemoved: true })
    expect(store.getState().activityClearedAtByPaneKey['tab-a:1']).toBeUndefined()
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-a:1']).toBeUndefined()
  })
})

describe('dropAgentStatusByTabPrefix preserveActivityClearedState', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps cutoffs and manual-unread stamps for a mirrored-tab retraction sweep', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-a:1', { state: 'done', prompt: 'p', agentType: 'claude' })
    store.getState().applyActivityClearedAt({ 'tab-a:1': 5_000 })
    store.getState().unacknowledgeAgents(['tab-a:1'])

    store.getState().dropAgentStatusByTabPrefix('tab-a', { preserveActivityClearedState: true })

    expect(store.getState().agentStatusByPaneKey['tab-a:1']).toBeUndefined()
    // Loss of contact is not pane death: the host republishes the same panes on reconnect,
    // and the preserved cutoff keeps cleared activity from replaying.
    expect(store.getState().activityClearedAtByPaneKey['tab-a:1']).toBe(5_000)
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-a:1']).toBeGreaterThan(0)

    store.getState().dropAgentStatusByTabPrefix('tab-a')
    expect(store.getState().activityClearedAtByPaneKey['tab-a:1']).toBeUndefined()
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-a:1']).toBeUndefined()
  })
})

describe('sanitizeActivityClearedAtByPaneKey hydration TTL', () => {
  it('keeps cutoffs past the 7-day ack TTL so they outlive the persisted entries they guard', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    const record = { 'tab-a:1': eightDaysAgo }
    // Main prunes persisted entries at 7d from receivedAt; a same-aged cutoff must survive
    // hydration or the entry it shadows replays as unread on restart.
    expect(sanitizeAcknowledgedAgentsByPaneKey(record)).toEqual({})
    expect(sanitizeActivityClearedAtByPaneKey(record)).toEqual(record)

    const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000
    expect(sanitizeActivityClearedAtByPaneKey({ 'tab-a:1': fifteenDaysAgo })).toEqual({})
  })
})
