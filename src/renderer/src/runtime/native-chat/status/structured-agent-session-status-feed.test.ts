import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../../shared/agent-session/agent-session-wire'
import '../../../../../shared/agent-session/agent-session-attention-capabilities'

const mocks = vi.hoisted(() => ({
  subscribeStatus: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('../requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from './structured-agent-session-status-feed'

const LOCAL = { kind: 'local' } as const

function summary(
  sessionId: string,
  status: AgentSessionStatusSummary['status'] = 'idle'
): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: 'wt-1',
    agent: 'codex',
    status,
    latestPrompt: 'hello',
    updatedAt: 1
  }
}

/** The event callback the feed handed to the most recent subscription. */
function hostEmit(index = 0): (event: AgentSessionStatusEvent) => void {
  const call = mocks.subscribeStatus.mock.calls[index]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return call[1] as (event: AgentSessionStatusEvent) => void
}

describe('structured agent session status feed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
  })

  afterEach(() => {
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.useRealTimers()
  })

  it('confirms sessions per connection and rejects late events from a disconnected stream', async () => {
    const feed = getStructuredAgentSessionStatusFeed(LOCAL)
    const deactivate = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    hostEmit()({ type: 'snapshot', sessions: [summary('one'), summary('two')] })
    expect(feed.getSessionObservation('one')).toBe('live')
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(feed.getSessionObservation('one')).toBe('live')
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
    hostEmit()({ type: 'end' })
    expect(feed.getSessionObservation('one')).toBe('unverifiable')
    hostEmit()({ type: 'status', session: summary('one') })
    expect(feed.getSessionObservation('one')).toBe('unverifiable')
    await vi.advanceTimersByTimeAsync(300)
    hostEmit(1)({ type: 'snapshot', sessions: [summary('two')] })
    expect(feed.getSessionObservation('two')).toBe('live')
    expect(feed.getSessionObservation('one')).toBe('unverifiable')
    expect(feed.getSnapshot().has('one')).toBe(true)
    hostEmit(1)({ type: 'status', session: summary('one') })
    expect(feed.getSessionObservation('one')).toBe('live')
    deactivate()
    expect(feed.getSessionObservation('one')).toBe('unverifiable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
