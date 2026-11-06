import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store-test-helpers'

// Directly test paneKey reuse: minted IDs make ordinary collisions rare, but stale closed-pane acks must never suppress a future unvisited signal.

describe('acknowledgedAgentsByPaneKey cleanup on teardown', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removeAgentStatusByTabPrefix drops every ack entry whose paneKey starts with the tab prefix', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-10:0', { state: 'working', prompt: 'p', agentType: 'claude' })
    store.getState().acknowledgeAgents(['tab-1:0', 'tab-1:1', 'tab-10:0'])
    store.setState({
      activityClearedAtByPaneKey: { 'tab-1:0': 100, 'tab-10:0': 300 },
      manuallyUnreadTurnsByPaneKey: { 'tab-1:1': 200, 'tab-10:0': 400 }
    })

    store.getState().removeAgentStatusByTabPrefix('tab-1')

    const ack = store.getState().acknowledgedAgentsByPaneKey
    expect(ack['tab-1:0']).toBeUndefined()
    expect(ack['tab-1:1']).toBeUndefined()
    // Delimiter prevents tab-1 prefixes matching tab-10.
    expect(ack['tab-10:0']).toBeGreaterThan(0)
    expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'tab-10:0': 300 })
    expect(store.getState().manuallyUnreadTurnsByPaneKey).toEqual({ 'tab-10:0': 400 })
  })

  it('removeAgentStatus leaves read state alone for a retained-only pane (unverified SSH exit)', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    // Unconditional PTY exit may be unverified SSH loss; preserve retained read state so reconnect does not rebold acked rows or replay cleared history.
    store.getState().acknowledgeAgents(['tab-6:0'])
    store.setState({
      activityClearedAtByPaneKey: { 'tab-6:0': 100 },
      manuallyUnreadTurnsByPaneKey: { 'tab-6:0': 200 }
    })
    const epochBefore = store.getState().agentStatusEpoch

    store.getState().removeAgentStatus('tab-6:0')

    expect(store.getState().acknowledgedAgentsByPaneKey['tab-6:0']).toBeGreaterThan(0)
    expect(store.getState().activityClearedAtByPaneKey['tab-6:0']).toBe(100)
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-6:0']).toBe(200)
    expect(store.getState().agentStatusEpoch).toBe(epochBefore)
  })
})
