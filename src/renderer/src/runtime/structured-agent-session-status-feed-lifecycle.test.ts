import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: vi.fn() }))

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
  hostExecutionOwned: true
}
const done: AgentSessionStatusSummary = {
  ...owned,
  sessionId: 'completed',
  status: 'idle',
  hostExecutionOwned: undefined
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
    subscription().emit({ type: 'snapshot', sessions: [owned, done] })
    subscription().emit({ type: 'end' })
    expect(subscription().unsubscribe).toHaveBeenCalledOnce()
    expect(feed.getSnapshot().get('running')).toEqual({ ...owned, hostExecutionOwned: undefined })
    expect(feed.getSnapshot().get('completed')).toBe(done)
    subscription().emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    subscription(1).emit({ type: 'snapshot', sessions: [done] })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    subscription(1).emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBe(true)
  })

  it('retains history without ownership while stopped and until remount receives fresh evidence', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const deactivate = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'snapshot', sessions: [owned, done] })
    deactivate()
    expect(vi.getTimerCount()).toBe(0)
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    expect(feed.getSnapshot().get('running')?.updatedAt).toBe(owned.updatedAt)
    expect(feed.getSnapshot().get('completed')).toBe(done)
    feed.activate()
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    subscription(1).emit({ type: 'snapshot', sessions: [owned] })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBe(true)
  })

  it('does not notify or reallocate already unowned historical rows on teardown', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const deactivate = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'snapshot', sessions: [done] })
    const previous = feed.getSnapshot()
    const listener = vi.fn()
    feed.subscribe(listener)
    deactivate()
    expect(feed.getSnapshot()).toBe(previous)
    expect(listener).not.toHaveBeenCalled()
  })
})
