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
    getStructuredAgentSessionStatusFeed(REMOTE).activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
    )
    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(mocks.supportsCapability).toHaveBeenCalledOnce()
  })

  it('subscribes once the remote host advertises the status feed', async () => {
    getStructuredAgentSessionStatusFeed(REMOTE).activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
    expect(mocks.subscribeStatus.mock.calls[0]?.[0]).toEqual(REMOTE)
  })

  it('reconnects when the capability probe fails, which is not an answer', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('relay unreachable'))
    getStructuredAgentSessionStatusFeed(REMOTE).activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(2)
    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
  })

  it('probes nothing for a local host, which is this build', async () => {
    getStructuredAgentSessionStatusFeed(LOCAL).activate()

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
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
