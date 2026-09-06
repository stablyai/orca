import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

// Why: paneKeys are generated from `${tabId}:${paneId}`, and both ids are
// freshly minted on creation, so a reused paneKey is extremely unlikely to
// surface through ordinary UI flow. These tests exercise the cleanup path
// directly by simulating the "close and re-create the same paneKey" case —
// this is the only guarantee that closed panes can't leak stale acks that
// silently suppress the "unvisited" signal on future paneKey collisions.

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
    // Why: the ":" delimiter on the prefix guards against false-prefix matches
    // across tab ids that share a leading substring (tab-1 vs tab-10).
    expect(ack['tab-10:0']).toBeGreaterThan(0)
    expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'tab-10:0': 300 })
    expect(store.getState().manuallyUnreadTurnsByPaneKey).toEqual({ 'tab-10:0': 400 })
  })

  it('removeAgentStatus leaves read state alone for a retained-only pane (unverified SSH exit)', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    // Why: PTY exit calls removeAgentStatus unconditionally, including a synthetic exit from a
    // lost SSH link. The live row is already gone; the retained/persisted read state must
    // survive so acked rows do not re-bold and cleared history does not replay on reconnect.
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
    // Why: simulate a dismissed/retained-only row — no live entry but an ack
    // was planted earlier in the session. Without cleanup on this path, the
    // ack would outlive every lifecycle and silently suppress a future
    // paneKey collision's unvisited signal.
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

    // Session 1: agent runs on tab-1:0, user acks it, pane state is torn down
    // without marking the whole tab closed.
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'first', agentType: 'claude' })
    store.getState().acknowledgeAgents(['tab-1:0'])
    const firstAck = store.getState().acknowledgedAgentsByPaneKey['tab-1:0']
    expect(firstAck).toBeGreaterThan(0)

    store.getState().removeAgentStatus('tab-1:0')
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()

    // Session 2: a brand-new tab+pane happens to collide on the same paneKey,
    // some time later. The ack from session 1 must NOT suppress the
    // unvisited signal for this new agent.
    vi.setSystemTime(new Date('2026-04-29T12:05:00.000Z'))
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'second', agentType: 'codex' })
    const newEntry = store.getState().agentStatusByPaneKey['tab-1:0']
    const ackAt = store.getState().acknowledgedAgentsByPaneKey['tab-1:0'] ?? 0

    // Why: the unvisited rule (WorktreeCardAgents' unvisitedByPaneKey) is
    // `ackAt < stateStartedAt`. A leaked session-1 ack would still be
    // greater than the second paneKey's fresh stateStartedAt only by
    // accident of wall-clock ordering, but more robustly: after cleanup,
    // ackAt is 0, which is strictly less than any stateStartedAt.
    expect(ackAt).toBe(0)
    expect(ackAt < newEntry.stateStartedAt).toBe(true)
  })
})

// Why: only the terminal-view path cleared unreadAgentCompletionPanes, so an
// Activity-page ack left the tab dot lit.
describe('acknowledgeAgents clears the unread agent-completion marker', () => {
  it('drops the pane from unreadAgentCompletionPanes', () => {
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:0', { state: 'done', prompt: 'p', agentType: 'claude' })
    store.getState().markAgentCompletionPaneUnread('tab-1:0')
    expect(store.getState().unreadAgentCompletionPanes['tab-1:0']).toBe(true)

    store.getState().acknowledgeAgents(['tab-1:0'])

    expect(store.getState().unreadAgentCompletionPanes['tab-1:0']).toBeUndefined()
  })

  it('leaves other panes and the terminal-bell unread map untouched', () => {
    const store = createTestStore()
    store.getState().markAgentCompletionPaneUnread('tab-1:0')
    store.getState().markAgentCompletionPaneUnread('tab-2:0')
    store.getState().markTerminalPaneUnread('tab-1:0')

    store.getState().acknowledgeAgents(['tab-1:0'])

    expect(store.getState().unreadAgentCompletionPanes['tab-2:0']).toBe(true)
    // Why: a BEL is a separate signal; acking the agent must not silence it.
    expect(store.getState().unreadTerminalPanes['tab-1:0']).toBe(true)
  })
})
