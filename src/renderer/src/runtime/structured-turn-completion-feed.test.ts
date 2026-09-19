import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { StructuredTurnCompletion } from '../../../shared/structured-turn-completion'

const mocks = vi.hoisted(() => ({
  subscribeCompletion: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionTurnCompletion: mocks.subscribeCompletion
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  getStructuredTurnCompletionFeed,
  resetStructuredTurnCompletionFeedsForTests
} from './structured-turn-completion-feed'

const REMOTE = { kind: 'environment', environmentId: 'env-1' } as const
const LOCAL = { kind: 'local' } as const

function completionFrame(turnId = 'turn-1'): unknown {
  return {
    type: 'completion',
    completion: {
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'wt-1',
        workspaceKind: 'git-worktree'
      },
      sessionId: 'session-1',
      turnId,
      outcome: 'success',
      completedAt: 1_700
    }
  }
}

/** The raw event callback the feed handed to the most recent subscription. */
function hostEmit(index = 0): (event: unknown) => void {
  const call = mocks.subscribeCompletion.mock.calls[index]
  if (!call) {
    throw new Error('completion feed not subscribed')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: argument 1 of the mocked subscribe is always the event callback.
  return call[1] as (event: unknown) => void
}

describe('structured turn completion feed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetStructuredTurnCompletionFeedsForTests()
    mocks.subscribeCompletion.mockResolvedValue({
      unsubscribe: mocks.unsubscribe
    })
    mocks.supportsCapability.mockResolvedValue(true)
  })

  afterEach(() => {
    resetStructuredTurnCompletionFeedsForTests()
    vi.useRealTimers()
  })

  it('never subscribes, and never retries, against a host without the capability', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    getStructuredTurnCompletionFeed(REMOTE).activate()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY
    )
    expect(mocks.subscribeCompletion).not.toHaveBeenCalled()
  })

  it('does not probe a local host, which is this build', async () => {
    getStructuredTurnCompletionFeed(LOCAL).activate()
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.subscribeCompletion).toHaveBeenCalledTimes(1)
  })

  it('announces a completion to every listener', async () => {
    const feed = getStructuredTurnCompletionFeed(LOCAL)
    feed.activate()
    const seen: StructuredTurnCompletion[] = []
    const other: StructuredTurnCompletion[] = []
    feed.subscribe((completion) => seen.push(completion))
    feed.subscribe((completion) => other.push(completion))
    await vi.advanceTimersByTimeAsync(0)

    hostEmit()(completionFrame())

    expect(seen.map((completion) => completion.turnId)).toEqual(['turn-1'])
    expect(other.map((completion) => completion.turnId)).toEqual(['turn-1'])
  })

  it('drops an event it cannot place rather than passing on a half-read completion', async () => {
    const feed = getStructuredTurnCompletionFeed(LOCAL)
    feed.activate()
    const seen: StructuredTurnCompletion[] = []
    feed.subscribe((completion) => seen.push(completion))
    await vi.advanceTimersByTimeAsync(0)

    hostEmit()({ type: 'completion', completion: { sessionId: 'session-1' } })
    hostEmit()({ type: 'completion' })
    hostEmit()('nonsense')

    expect(seen).toEqual([])
  })

  it('keeps every other listener when one throws', async () => {
    const feed = getStructuredTurnCompletionFeed(LOCAL)
    feed.activate()
    const seen: StructuredTurnCompletion[] = []
    feed.subscribe(() => {
      throw new Error('listener exploded')
    })
    feed.subscribe((completion) => seen.push(completion))
    await vi.advanceTimersByTimeAsync(0)

    hostEmit()(completionFrame())

    expect(seen).toHaveLength(1)
  })

  it('baselines on reconnect: nothing is queued or replayed across the gap', async () => {
    const feed = getStructuredTurnCompletionFeed(LOCAL)
    feed.activate()
    const seen: StructuredTurnCompletion[] = []
    feed.subscribe((completion) => seen.push(completion))
    await vi.advanceTimersByTimeAsync(0)

    // The host ends the stream; the client reconnects.
    hostEmit()({ type: 'end' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.subscribeCompletion).toHaveBeenCalledTimes(2)

    // A reopened stream opens on nothing. If a completion that happened during the gap ever
    // arrives here, live-only recovery has silently become catch-up.
    expect(seen).toEqual([])
    hostEmit(1)(completionFrame('turn-after-reconnect'))
    expect(seen.map((completion) => completion.turnId)).toEqual(['turn-after-reconnect'])
  })

  it('tears the stream down once nothing is activated, leaving no reconnect running', async () => {
    const feed = getStructuredTurnCompletionFeed(LOCAL)
    const release = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    release()

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.subscribeCompletion).toHaveBeenCalledTimes(1)
  })

  it('shares one stream per runtime target across every activation', async () => {
    const first = getStructuredTurnCompletionFeed(LOCAL)
    const second = getStructuredTurnCompletionFeed(LOCAL)
    expect(second).toBe(first)

    const releaseFirst = first.activate()
    const releaseSecond = second.activate()
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.subscribeCompletion).toHaveBeenCalledTimes(1)
    releaseFirst()
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
    releaseSecond()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
