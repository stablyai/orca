import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'

// Why: queueMicrotask is used by the agent-status slice to schedule the
// freshness timer after state updates. In tests we need to flush microtasks
// before advancing fake timers so the setTimeout gets registered.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

describe('agent status freshness expiry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances agentStatusEpoch when a fresh entry crosses the stale threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests' }, 'codex')

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
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests' }, 'codex')
    // set bumps to 1, remove bumps to 2
    store.getState().removeAgentStatus('tab-1:1')
    expect(store.getState().agentStatusEpoch).toBe(2)

    // Flush microtask and advance past stale threshold
    await flushMicrotasks()
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    // No additional bump since the entry was removed before the timer fires
    expect(store.getState().agentStatusEpoch).toBe(2)
  })
})

describe('agent status tool + assistant fields', () => {
  // Why: setAgentStatus schedules a real 30-minute freshness setTimeout via
  // queueMicrotask. Without fake timers those handles leak into the test
  // process and keep vitest alive past the run.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes toolName, toolInput, and lastAssistantMessage straight onto the entry', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'working',
        prompt: 'Edit the config',
        toolName: 'Edit',
        toolInput: '/src/config.ts',
        lastAssistantMessage: 'Edited config.ts'
      },
      'claude'
    )
    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.toolName).toBe('Edit')
    expect(entry.toolInput).toBe('/src/config.ts')
    expect(entry.lastAssistantMessage).toBe('Edited config.ts')
  })

  it('clears fields to undefined when a later payload omits them', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'working',
        prompt: 'Edit the config',
        toolName: 'Edit',
        toolInput: '/src/config.ts',
        lastAssistantMessage: 'Edited config.ts'
      },
      'claude'
    )
    // Why: the main-process cache is the source of truth for tool/assistant
    // fields — a fresh-turn reset surfaces as undefined on the payload, and
    // the store must not fall back to the prior entry's values.
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'Next step' }, 'claude')
    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.toolName).toBeUndefined()
    expect(entry.toolInput).toBeUndefined()
    expect(entry.lastAssistantMessage).toBeUndefined()
  })

  it('preserves prior agentType when payload omits it', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
  })

  it('preserves prior agentType when payload sends the "unknown" sentinel', () => {
    // Why: 'unknown' is the sentinel for "agent didn't identify itself". A
    // later ping that loses the identity must not stomp a well-known prior
    // identity (e.g. 'claude' learned from an earlier hook ping), or the UI
    // label/icon would flicker from "Claude" to the neutral "Agent".
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'unknown' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
  })

  it('overwrites prior agentType when payload sends a different known value', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'cursor' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('cursor')
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
})

describe('agent status retention + prefix sweep', () => {
  // Why: setAgentStatus schedules a real 30-minute freshness setTimeout via
  // queueMicrotask. Use fake timers so the handle does not leak into the
  // test process.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removeAgentStatusByTabPrefix scopes by the ":" delimiter so tab-1 does not sweep tab-10', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:0', { state: 'working', prompt: 'p' }, 'claude')
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p' }, 'claude')
    store.getState().setAgentStatus('tab-10:0', { state: 'working', prompt: 'p' }, 'claude')

    store.getState().removeAgentStatusByTabPrefix('tab-1')

    const map = store.getState().agentStatusByPaneKey
    expect(map['tab-1:0']).toBeUndefined()
    expect(map['tab-1:1']).toBeUndefined()
    // Why: the ":" delimiter on the prefix guards against false-prefix matches
    // across tab ids that share a leading substring (tab-1 vs tab-10).
    expect(map['tab-10:0']).toBeDefined()
  })

  it('dismissRetainedAgentsByWorktree removes only entries for the given worktreeId', () => {
    const store = createTestStore()
    const now = Date.now()
    const entryA: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-a:0',
      stateHistory: []
    }
    const entryB: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-b:0',
      stateHistory: []
    }
    const retainedA: RetainedAgentEntry = {
      entry: entryA,
      worktreeId: 'wt-a',
      tab: { id: 'tab-a', title: 'claude' } as unknown as TerminalTab,
      agentType: 'claude',
      startedAt: now
    }
    const retainedB: RetainedAgentEntry = {
      entry: entryB,
      worktreeId: 'wt-b',
      tab: { id: 'tab-b', title: 'claude' } as unknown as TerminalTab,
      agentType: 'claude',
      startedAt: now
    }

    store.getState().retainAgent(retainedA)
    store.getState().retainAgent(retainedB)
    store.getState().dismissRetainedAgentsByWorktree('wt-a')

    const retained = store.getState().retainedAgentsByPaneKey
    expect(retained['tab-a:0']).toBeUndefined()
    expect(retained['tab-b:0']).toBeDefined()
    expect(retained['tab-b:0'].worktreeId).toBe('wt-b')
  })

  it('pruneRetainedAgents keeps only entries whose worktreeId is in the valid set', () => {
    const store = createTestStore()
    const now = Date.now()
    const entryA: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-a:0',
      stateHistory: []
    }
    const entryB: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-b:0',
      stateHistory: []
    }
    const retainedA: RetainedAgentEntry = {
      entry: entryA,
      worktreeId: 'wt-a',
      tab: { id: 'tab-a', title: 'claude' } as unknown as TerminalTab,
      agentType: 'claude',
      startedAt: now
    }
    const retainedB: RetainedAgentEntry = {
      entry: entryB,
      worktreeId: 'wt-b',
      tab: { id: 'tab-b', title: 'claude' } as unknown as TerminalTab,
      agentType: 'claude',
      startedAt: now
    }

    store.getState().retainAgent(retainedA)
    store.getState().retainAgent(retainedB)
    store.getState().pruneRetainedAgents(new Set(['wt-a']))

    const retained = store.getState().retainedAgentsByPaneKey
    expect(retained['tab-a:0']).toBeDefined()
    expect(retained['tab-a:0'].worktreeId).toBe('wt-a')
    expect(retained['tab-b:0']).toBeUndefined()
  })
})
