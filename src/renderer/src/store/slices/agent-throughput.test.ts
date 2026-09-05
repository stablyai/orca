import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentThroughputSample } from '../../../../shared/agent-throughput-types'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-1:0f7c1b2e-3d4a-4c5b-8e6f-7a8b9c0d1e2f'

function sample(overrides: Partial<AgentThroughputSample> = {}): AgentThroughputSample {
  return {
    paneKey: PANE,
    agentType: 'claude',
    messageId: 'msg_1',
    model: 'claude-fable-5-1',
    outputTokens: 500,
    generationMs: 10_000,
    tokensPerSecond: 50,
    completedAt: 1_000,
    turnOutputTokens: 500,
    turnGenerationMs: 10_000,
    turnMessageCount: 1,
    observedAt: 1_000,
    ...overrides
  }
}

describe('agent throughput slice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the newer of a push and a snapshot per pane', () => {
    const store = createTestStore()
    store.getState().setAgentThroughput(sample({ observedAt: 2_000, messageId: 'push' }))
    store
      .getState()
      .mergeAgentThroughputSnapshot([sample({ observedAt: 1_000, messageId: 'older-snapshot' })])
    expect(store.getState().agentThroughputByPaneKey[PANE]?.messageId).toBe('push')

    store
      .getState()
      .mergeAgentThroughputSnapshot([sample({ observedAt: 3_000, messageId: 'newer-snapshot' })])
    expect(store.getState().agentThroughputByPaneKey[PANE]?.messageId).toBe('newer-snapshot')
  })

  it('does not let a snapshot pulled before a clear resurrect the cleared pane', () => {
    const store = createTestStore()
    store.getState().setAgentThroughput(sample({ observedAt: 1_000 }))
    store.getState().clearAgentThroughput(PANE)
    expect(store.getState().agentThroughputByPaneKey[PANE]).toBeUndefined()

    // Why: the snapshot request left before the clear (observedAt 1_000 < cleared at 5_000).
    store.getState().mergeAgentThroughputSnapshot([sample({ observedAt: 1_000 })])
    expect(store.getState().agentThroughputByPaneKey[PANE]).toBeUndefined()

    // Why: a live push after the clear is a new reading and lifts the fence.
    store.getState().setAgentThroughput(sample({ observedAt: 6_000, messageId: 'after-clear' }))
    expect(store.getState().agentThroughputByPaneKey[PANE]?.messageId).toBe('after-clear')
    expect(store.getState().agentThroughputClearedAt[PANE]).toBeUndefined()
  })
})
