// LIVE-ONLY PIN for the renderer half of the completion feed.
//
// The point of most of these is not that the feed delivers, but that it REMEMBERS NOTHING: no
// snapshot for a late listener, no buffer, and no catch-up across a reconnect. A refactor that
// quietly adds a cursor or a replay arm to make reconnects "lossless" has to fail here, because
// what it would actually do is light the dot for work the user already read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), supportsCapability: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribe
}))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  getStructuredAgentSessionTurnCompletionFeed,
  resetStructuredAgentSessionTurnCompletionFeedsForTests
} from './structured-agent-session-turn-completion-feed'

type Subscription = {
  emit: (event: AgentSessionTurnCompletionEvent) => void
  fail: (error: unknown) => void
  close: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: Subscription[] = []

function subscription(index = 0): Subscription {
  const value = subscriptions[index]
  if (!value) {
    throw new Error(`missing subscription ${index}; opened ${subscriptions.length}`)
  }
  return value
}

function completion(turnId: string): AgentSessionTurnCompletion {
  return {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    sessionId: 'session-1',
    turnId,
    outcome: 'success',
    completedAt: 1
  }
}

describe('structured turn completion feed (renderer)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    subscriptions.length = 0
    mocks.subscribe.mockReset()
    mocks.supportsCapability.mockReset()
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.subscribe.mockImplementation(
      (
        _target: unknown,
        emit: Subscription['emit'],
        fail: Subscription['fail'],
        close: Subscription['close']
      ) => {
        const unsubscribe = vi.fn()
        subscriptions.push({ emit, fail, close, unsubscribe })
        return Promise.resolve({ unsubscribe })
      }
    )
  })

  afterEach(() => {
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    vi.useRealTimers()
  })

  it('delivers completions to every listener while the stream is up', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const first: string[] = []
    const second: string[] = []
    feed.subscribe((event) => first.push(event.turnId))
    feed.subscribe((event) => second.push(event.turnId))
    await vi.advanceTimersByTimeAsync(0)

    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    expect(first).toEqual(['turn-1'])
    expect(second).toEqual(['turn-1'])
  })

  it('replays nothing to a listener that subscribes after a completion landed', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    const late: string[] = []
    feed.subscribe((event) => late.push(event.turnId))

    // There is no buffer to hand over. The edge already passed.
    expect(late).toEqual([])
  })

  it('reconnects into an empty stream and never asks the host what it missed', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe((event) => seen.push(event.turnId))
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'completion', completion: completion('before-drop') })

    subscription().close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(subscriptions).toHaveLength(2)

    // NO CURSOR ANYWHERE: the reopen call carries the target and three callbacks and nothing
    // else. A catch-up arm would have to add an argument here, so this assertion is the pin.
    for (const call of mocks.subscribe.mock.calls) {
      expect(call).toHaveLength(4)
      expect(call[0]).toEqual({ kind: 'local' })
      expect(call.slice(1).every((argument) => typeof argument === 'function')).toBe(true)
    }

    // The reopened stream is empty until the host sends something new; whatever completed during
    // the gap is gone, not queued.
    expect(seen).toEqual(['before-drop'])
    subscription(1).emit({ type: 'completion', completion: completion('after-reconnect') })
    expect(seen).toEqual(['before-drop', 'after-reconnect'])
  })

  it.each([
    ['an end frame', (value: Subscription) => value.emit({ type: 'end' })],
    ['a transport error', (value: Subscription) => value.fail(new Error('relay gone'))],
    ['a close', (value: Subscription) => value.close()]
  ])('reopens after %s', async (_label, drop) => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)

    drop(subscription())
    await vi.advanceTimersByTimeAsync(5_000)

    expect(subscriptions).toHaveLength(2)
  })

  it('does not subscribe a remote host that lacks the capability, and does not retry it', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    const feed = getStructuredAgentSessionTurnCompletionFeed({
      kind: 'environment',
      environmentId: 'env-1'
    })
    feed.activate()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mocks.subscribe).not.toHaveBeenCalled()
    // An old host is a settled answer, not a fault; retrying would probe the relay forever.
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(1)
  })

  it('subscribes a remote host that advertises the capability', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({
      kind: 'environment',
      environmentId: 'env-1'
    })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      'agent-session.turn-completion.v1'
    )
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  })

  it('stops the stream when the last activation is released and opens a fresh one on the next', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    const release = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const opened = subscription()

    release()
    expect(opened.unsubscribe).toHaveBeenCalledTimes(1)

    // A late frame from the torn-down stream reaches nobody.
    const seen: string[] = []
    feed.subscribe((event) => seen.push(event.turnId))
    opened.emit({ type: 'completion', completion: completion('after-stop') })
    expect(seen).toEqual([])

    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriptions).toHaveLength(2)
  })

  it('keeps delivering to the other listeners when one throws', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe(() => {
      throw new Error('listener exploded')
    })
    feed.subscribe((event) => seen.push(event.turnId))
    await vi.advanceTimersByTimeAsync(0)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscription().emit({ type: 'completion', completion: completion('turn-1') })
    warn.mockRestore()

    expect(seen).toEqual(['turn-1'])
  })

  it('hands the same owner to every caller for one target and separate owners per target', () => {
    const local = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    expect(getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })).toBe(local)
    expect(
      getStructuredAgentSessionTurnCompletionFeed({ kind: 'environment', environmentId: 'env-1' })
    ).not.toBe(local)
  })
})
