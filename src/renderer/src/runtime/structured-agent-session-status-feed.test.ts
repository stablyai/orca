import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  subscribeStatus: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from './structured-agent-session-status-feed'

const REMOTE = { kind: 'environment', environmentId: 'env-1' } as const
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

  it('never subscribes, and never retries, against a host without the status feed', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    const feed = getStructuredAgentSessionStatusFeed(REMOTE)
    feed.activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
    )
    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(feed.getSessionSleepState('session-1')).toBeNull()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(2)
  })

  it('subscribes once the remote host advertises the status feed', async () => {
    getStructuredAgentSessionStatusFeed(REMOTE).activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
    expect(mocks.subscribeStatus.mock.calls[0]?.[0]).toEqual(REMOTE)
  })

  it('reconnects when the capability probe fails, which is not an answer', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('relay unreachable'))
    const feed = getStructuredAgentSessionStatusFeed(REMOTE)
    feed.activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(4)
    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(feed.getSessionSleepState('session-1')).toBeUndefined()
    mocks.supportsCapability.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(500)
    hostEmit()({ type: 'snapshot', sessions: [{ ...summary('session-1'), sleptAt: 5 }] })
    expect(feed.getSessionSleepState('session-1')).toBe(5)
  })

  it('probes nothing for a local host, which is this build', async () => {
    getStructuredAgentSessionStatusFeed(LOCAL).activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
  })

  it('keeps Sleep unknown through naming metadata until the full status answer', async () => {
    const feed = getStructuredAgentSessionStatusFeed(LOCAL)
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const naming: AgentSessionStatusEvent = {
      type: 'snapshot',
      sessions: [],
      namingActiveSessionIds: []
    }
    hostEmit()(naming)
    expect(feed.getNamingActive('session-1')).toBe(false)
    expect(feed.getSessionSleepState('session-1')).toBeUndefined()
    hostEmit()({ type: 'snapshot', sessions: [{ ...summary('session-1'), sleptAt: 5 }] })
    hostEmit()(naming)
    expect(feed.getSessionSleepState('session-1')).toBe(5)
    hostEmit()({ type: 'snapshot', sessions: [] })
    expect(feed.getSessionSleepState('session-2')).toBeNull()
    expect(feed.getSessionSleepState('session-1')).toBe(5)
  })

  it('merges a snapshot over the cached rows instead of retracting them', async () => {
    const feed = getStructuredAgentSessionStatusFeed(LOCAL)
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    hostEmit()({ type: 'snapshot', sessions: [summary('session-1'), summary('session-2')] })
    expect([...feed.getSnapshot().keys()]).toEqual(['session-1', 'session-2'])

    // A restarted host restores its readable sessions after the stream reopens.
    hostEmit()({ type: 'snapshot', sessions: [] })
    expect([...feed.getSnapshot().keys()]).toEqual(['session-1', 'session-2'])

    hostEmit()({ type: 'snapshot', sessions: [summary('session-1', 'working')] })
    expect(feed.getSnapshot().get('session-1')?.status).toBe('working')
    expect(feed.getSnapshot().get('session-2')?.status).toBe('idle')
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

  it.each(['error', 'close', 'reject'] as const)(
    'revokes confirmation on subscription %s',
    async (failure) => {
      let reject!: (error: Error) => void
      mocks.subscribeStatus.mockImplementationOnce(
        () =>
          new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise
          })
      )
      const feed = getStructuredAgentSessionStatusFeed(LOCAL)
      feed.activate()
      hostEmit()({ type: 'status', session: summary('one') })
      expect(feed.getSessionObservation('one')).toBe('live')
      if (failure === 'reject') {
        reject(new Error('disconnected'))
      } else {
        mocks.subscribeStatus.mock.calls[0][failure === 'error' ? 2 : 3]()
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(feed.getSessionObservation('one')).toBe('unverifiable')
      hostEmit()({ type: 'status', session: summary('one') })
      expect(feed.getSessionObservation('one')).toBe('unverifiable')
      expect(vi.getTimerCount()).toBe(1)
    }
  )

  it('stops a pending reconnect when the feeds are reset between tests', async () => {
    getStructuredAgentSessionStatusFeed(LOCAL).activate()
    await vi.advanceTimersByTimeAsync(0)
    hostEmit()({ type: 'end' })
    expect(vi.getTimerCount()).toBe(1)

    resetStructuredAgentSessionStatusFeedsForTests()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
  })
})
