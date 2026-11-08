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
  it('orders naming observations without changing retained turns, Sleep or confirmation', async () => {
    const feed = getStructuredAgentSessionStatusFeed(LOCAL)
    const stop = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const retained = {
      ...summary('one'),
      turnOutcome: 'interruption' as const,
      permissionMode: 'plan',
      model: 'model',
      statusStartedAt: 2,
      sleptAt: 3
    }
    hostEmit()({ type: 'status', session: retained })
    const status = feed.getSnapshot()
    const metadata = (conversationName: string) => ({
      type: 'snapshot' as const,
      sessions: [],
      namingActiveSessionIds: [],
      conversationNames: [{ sessionId: 'one', conversationName }]
    })
    hostEmit()(metadata('Before'))
    expect(feed.getSnapshot()).toBe(status)
    expect(feed.getSessionSleepState('one')).toBe(3)
    expect(feed.getSessionSleepState('cold')).toBeUndefined()
    expect(feed.getSessionObservation('cold')).toBe('unverifiable')
    hostEmit()({
      ...metadata('Before'),
      conversationNames: [
        {
          sessionId: 'one',
          conversationName: 'Before',
          namingError: { message: 'Failed', failedAt: 1 }
        }
      ]
    })
    hostEmit()(metadata('Before'))
    expect(feed.getNamingSnapshot().get('one')).not.toHaveProperty('namingError')
    hostEmit()({
      type: 'snapshot',
      sessions: [retained],
      conversationNames: JSON.parse('[null, {"sessionId":"one","conversationName":5}]')
    })
    expect(feed.getNamingSnapshot().get('one')?.conversationName).toBe('Before')
    hostEmit()({ ...metadata('After'), sessions: [{ ...retained, conversationName: 'Stale' }] })
    expect(feed.getNamingSnapshot().get('one')?.conversationName).toBe('After')
    hostEmit()({ type: 'end' })
    expect(feed.getSessionObservation('one')).toBe('unverifiable')
    expect(feed.getNamingSnapshot().get('one')?.conversationName).toBe('After')
    await vi.advanceTimersByTimeAsync(300)
    hostEmit(1)({
      ...metadata('Restarted'),
      conversationNames: [
        { sessionId: 'one', conversationName: 'Restarted' },
        { sessionId: 'cold', conversationName: 'Cold' }
      ]
    })
    expect(feed.getSessionObservation('one')).toBe('unverifiable')
    expect(feed.getSessionObservation('cold')).toBe('unverifiable')
    expect(feed.getSnapshot().get('one')).toMatchObject(retained)
    stop()
    expect(feed.getNamingSnapshot().get('one')?.conversationName).toBe('Restarted')
  })
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
})
