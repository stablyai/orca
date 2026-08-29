import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { flushMicrotasks } from './agent-status-test-harness'
import { createTestStore } from './store-test-helpers'

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
