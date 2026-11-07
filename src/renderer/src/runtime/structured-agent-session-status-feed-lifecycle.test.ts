import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('./rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from './structured-agent-session-status-feed'

type Subscription = {
  emit: (event: AgentSessionStatusEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
const subscriptions: Subscription[] = []
const owned: AgentSessionStatusSummary = {
  sessionId: 'running',
  workspaceId: 'workspace',
  agent: 'codex',
  status: 'working',
  latestPrompt: 'work',
  updatedAt: 1,
  hostExecutionOwned: true,
  hostExecutionPhase: 'starting'
}
const done: AgentSessionStatusSummary = {
  ...owned,
  sessionId: 'completed',
  status: 'idle',
  hostExecutionOwned: undefined,
  hostExecutionPhase: undefined,
  runtimePermission: null
}

function subscription(index = 0): Subscription {
  const value = subscriptions[index]
  if (!value) {
    throw new Error('missing subscription')
  }
  return value
}

describe('structured status feed execution authority lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStructuredAgentSessionStatusFeedsForTests()
    subscriptions.length = 0
    mocks.subscribe.mockReset()
    mocks.subscribe.mockImplementation((_target, emit: Subscription['emit']) => {
      const unsubscribe = vi.fn(() => emit({ type: 'end' }))
      subscriptions.push({ emit, unsubscribe })
      return Promise.resolve({ unsubscribe })
    })
  })

  afterEach(() => {
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.useRealTimers()
  })

  it('revokes on end before reentrant unsubscribe and ignores late frames', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getNamingActive('running')).toBeNull()
    subscription().emit({
      type: 'snapshot',
      sessions: [owned, done],
      namingActiveSessionIds: ['running']
    })
    subscription().emit({ type: 'snapshot', sessions: [] })
    expect(feed.getNamingActive('running')).toBe(true)
    subscription().emit({ type: 'end' })
    expect(feed.getNamingActive('running')).toBeNull()
    expect(subscription().unsubscribe).toHaveBeenCalledOnce()
    expect(feed.getSnapshot().get('running')).toEqual({
      ...owned,
      hostExecutionOwned: undefined,
      hostExecutionPhase: undefined,
      runtimePermission: null
    })
    expect(feed.getSnapshot().get('completed')).toBe(done)
    subscription().emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    subscription(1).emit({ type: 'snapshot', sessions: [] })
    expect(feed.getNamingActive('running')).toBeNull()
    subscription(1).emit({ type: 'snapshot', sessions: [done], namingActiveSessionIds: [] })
    subscription().emit({ type: 'snapshot', sessions: [], namingActiveSessionIds: ['running'] })
    expect(feed.getNamingActive('running')).toBe(false)
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    subscription(1).emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBe(true)
  })
})
