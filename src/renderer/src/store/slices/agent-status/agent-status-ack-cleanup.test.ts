import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store-test-helpers'

// Directly test paneKey reuse: minted IDs make ordinary collisions rare, but stale closed-pane acks must never suppress a future unvisited signal.

describe('acknowledgedAgentsByPaneKey cleanup on teardown', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removeAgentStatus drops the ack entry for the closed pane', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
    store.getState().acknowledgeAgents(['tab-1:0'])
    store.setState({
      activityClearedAtByPaneKey: { 'tab-1:0': 100 },
      manuallyUnreadTurnsByPaneKey: { 'tab-1:0': 200 }
    })
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeGreaterThan(0)

    store.getState().removeAgentStatus('tab-1:0')

    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(store.getState().activityClearedAtByPaneKey['tab-1:0']).toBeUndefined()
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-1:0']).toBeUndefined()
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

  it('dropAgentStatus drops the ack entry even when the pane had no live entry', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    // Retained-only dismissal must clear old acks even with no live entry, protecting future paneKey reuse.
    store.getState().acknowledgeAgents(['tab-2:0'])
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-2:0']).toBeGreaterThan(0)

    store.getState().dropAgentStatus('tab-2:0')

    expect(store.getState().acknowledgedAgentsByPaneKey['tab-2:0']).toBeUndefined()
  })

  it('dropAgentStatusByTabPrefix drops ack entries even when no live or retained entries matched', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().acknowledgeAgents(['tab-3:0', 'tab-3:1'])
    expect(Object.keys(store.getState().acknowledgedAgentsByPaneKey)).toEqual(
      expect.arrayContaining(['tab-3:0', 'tab-3:1'])
    )

    store.getState().dropAgentStatusByTabPrefix('tab-3')

    const ack = store.getState().acknowledgedAgentsByPaneKey
    expect(ack['tab-3:0']).toBeUndefined()
    expect(ack['tab-3:1']).toBeUndefined()
  })

  it('dropAgentStatusByTabPrefix clears pane-keyed activity maps without live rows', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.setState({
      activityClearedAtByPaneKey: { 'tab-4:0': 100 },
      manuallyUnreadTurnsByPaneKey: { 'tab-4:0': 200 }
    })

    store.getState().dropAgentStatusByTabPrefix('tab-4')

    expect(store.getState().activityClearedAtByPaneKey['tab-4:0']).toBeUndefined()
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-4:0']).toBeUndefined()
  })

  it('dropHibernatedAgentStatusPane clears pane-keyed activity maps without completion evidence', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.setState({
      activityClearedAtByPaneKey: { 'tab-5:0': 100 },
      manuallyUnreadTurnsByPaneKey: { 'tab-5:0': 200 }
    })

    store.getState().dropHibernatedAgentStatusPane('wt-1', 'tab-5:0')

    expect(store.getState().activityClearedAtByPaneKey['tab-5:0']).toBeUndefined()
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-5:0']).toBeUndefined()
  })

  it('a paneKey reused after teardown reads as unvisited (no leaked ack suppresses the signal)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'))
    const store = createTestStore()

    // First session leaves an ack after pane teardown without whole-tab close.
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'first', agentType: 'claude' })
    store.getState().acknowledgeAgents(['tab-1:0'])
    const firstAck = store.getState().acknowledgedAgentsByPaneKey['tab-1:0']
    expect(firstAck).toBeGreaterThan(0)

    store.getState().removeAgentStatus('tab-1:0')
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()

    // New session reuses paneKey; old ack must not suppress unvisited state.
    vi.setSystemTime(new Date('2026-04-29T12:05:00.000Z'))
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'second', agentType: 'codex' })
    const newEntry = store.getState().agentStatusByPaneKey['tab-1:0']
    const ackAt = store.getState().acknowledgedAgentsByPaneKey['tab-1:0'] ?? 0

    // Require ackAt=0 after cleanup, below any new stateStartedAt; clock accidents must not mask leaked acks.
    expect(ackAt).toBe(0)
    expect(ackAt < newEntry.stateStartedAt).toBe(true)
  })
})

// Activity-page acknowledgment must clear tab completion dot like terminal-view acknowledgment.
describe('acknowledgeAgents clears the unread agent-completion marker', () => {
  it('drops the pane from unreadAgentCompletionPanes', () => {
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:0', { state: 'done', prompt: 'p', agentType: 'claude' })
    store.setState({ unreadAgentCompletionPanes: { 'tab-1:0': 'agent-completion' } })
    expect(store.getState().unreadAgentCompletionPanes['tab-1:0']).toBe('agent-completion')

    store.getState().acknowledgeAgents(['tab-1:0'])

    expect(store.getState().unreadAgentCompletionPanes['tab-1:0']).toBeUndefined()
  })

  it('leaves other panes and the terminal-bell unread map untouched', () => {
    const store = createTestStore()
    store.setState({
      unreadAgentCompletionPanes: { 'tab-1:0': 'agent-completion', 'tab-2:0': 'agent-completion' },
      unreadTerminalPanes: { 'tab-1:0': 'terminal-bell' }
    })

    store.getState().acknowledgeAgents(['tab-1:0'])

    expect(store.getState().unreadAgentCompletionPanes['tab-2:0']).toBe('agent-completion')
    // Why: a BEL is a separate signal; acking the agent must not silence it.
    expect(store.getState().unreadTerminalPanes['tab-1:0']).toBe('terminal-bell')
  })
})
