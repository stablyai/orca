// Keep completion/prompt edges live-only: no late snapshot, buffering or reconnect catch-up, which would mark already-read work unread again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttentionEdge } from '../../../shared/agent-session-attention'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), supportsCapability: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribe
}))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  getStructuredAgentSessionTurnCompletionFeed,
  resetStructuredAgentSessionTurnCompletionFeedsForTests,
  structuredAgentSessionTurnCompletionFeedCountForTests as retainedCount
} from './structured-agent-session-turn-completion-feed'

function label(edge: AgentSessionAttentionEdge): string {
  return edge.type === 'completion' ? edge.completion.turnId : `prompt:${edge.prompt.promptId}`
}

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

function emitEdges(value: Subscription): void {
  value.emit({ type: 'completion', completion: completion('turn-live') })
  value.emit({
    type: 'prompt',
    prompt: {
      scope: completion('unused').scope,
      sessionId: 'session-1',
      promptId: 'approval-live',
      raisedAt: 1
    }
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized')
  }
  let reject: (error: Error) => void = () => {
    throw new Error('not initialized')
  }
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
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
    feed.subscribe((edge) => first.push(label(edge)))
    feed.subscribe((edge) => second.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)

    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    expect(first).toEqual(['turn-1'])
    expect(second).toEqual(['turn-1'])
  })

  it('delivers prompt edges beside completions, and drops an arm it cannot name', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)

    subscription().emit({
      type: 'prompt',
      prompt: {
        scope: completion('unused').scope,
        sessionId: 'session-1',
        promptId: 'approval-1',
        raisedAt: 1
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a newer host's arm this build cannot type.
    subscription().emit({ type: 'future-edge' } as unknown as AgentSessionTurnCompletionEvent)
    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    expect(seen).toEqual(['prompt:approval-1', 'turn-1'])
  })

  it('replays nothing to a listener that subscribes after a completion landed', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    const late: string[] = []
    feed.subscribe((edge) => late.push(label(edge)))

    // There is no buffer to hand over. The edge already passed.
    expect(late).toEqual([])
  })

  it('reconnects into an empty stream and never asks the host what it missed', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'completion', completion: completion('before-drop') })

    subscription().close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(subscriptions).toHaveLength(2)

    // Assert target plus callbacks only; adding a catch-up cursor must break this contract.
    for (const call of mocks.subscribe.mock.calls) {
      expect(call).toHaveLength(4)
      expect(call[0]).toEqual({ kind: 'local' })
      expect(call.slice(1).every((argument) => typeof argument === 'function')).toBe(true)
    }

    // Reopened streams deliver only future edges; completions during the gap are lost.
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
    let release = feed.activate()
    queueMicrotask(() => {
      release = feed.activate()
    })
    release()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mocks.subscribe).not.toHaveBeenCalled()
    // An old host is a settled answer, not a fault; retrying would probe the relay forever.
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(2)
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
    await vi.advanceTimersByTimeAsync(0)
    expect(opened.unsubscribe).toHaveBeenCalledTimes(1)

    // A late frame from the torn-down stream reaches nobody.
    const seen: string[] = []
    feed.subscribe((edge) => seen.push(label(edge)))
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
    feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscription().emit({ type: 'completion', completion: completion('turn-1') })
    warn.mockRestore()

    expect(seen).toEqual(['turn-1'])
  })

  it.each(['activation-first', 'listener-first'] as const)(
    'bounds distinct targets by live interest through %s cleanup and renewal',
    async (order) => {
      const held = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
      let release = held.activate()
      const seen: string[] = []
      let unlisten = held.subscribe((edge) => seen.push(label(edge)))
      const peer = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
      const releasePeer = peer.activate()
      const peerSeen: string[] = []
      const unlistenPeer = peer.subscribe((edge) => peerSeen.push(label(edge)))
      await vi.advanceTimersByTimeAsync(0)
      for (let index = 0; index < 12; index += 1) {
        getStructuredAgentSessionTurnCompletionFeed({
          kind: 'environment',
          environmentId: `lookup-${index}`
        })
        const feed = getStructuredAgentSessionTurnCompletionFeed({
          kind: 'environment',
          environmentId: `env-${index}`
        })
        const stop = feed.activate()
        const edges: string[] = []
        const off = feed.subscribe((edge) => edges.push(label(edge)))
        await vi.advanceTimersByTimeAsync(0)
        emitEdges(subscription(index + 1))
        expect(edges).toEqual(['turn-live', 'prompt:approval-live'])
        if (order === 'activation-first') {
          stop()
          off()
        } else {
          off()
          stop()
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(subscription(index + 1).unsubscribe).toHaveBeenCalledTimes(1)
        expect(retainedCount()).toBe(1)
      }
      expect(subscriptions).toHaveLength(13)
      emitEdges(subscription())
      expect(seen).toEqual(['turn-live', 'prompt:approval-live'])
      expect(peerSeen).toEqual(seen)
      releasePeer()
      unlistenPeer()
      await vi.advanceTimersByTimeAsync(0)
      emitEdges(subscription())
      expect(seen).toHaveLength(4)
      expect(peerSeen).toHaveLength(2)
      // Both main's independent effects and the combined release-first caller renew in one pass.
      const oldRelease = release
      const oldUnlisten = unlisten
      if (order === 'activation-first') {
        release()
        unlisten()
      } else {
        unlisten()
        release()
      }
      unlisten = peer.subscribe((edge) => seen.push(label(edge)))
      release = held.activate()
      oldRelease()
      oldUnlisten()
      await vi.advanceTimersByTimeAsync(0)
      expect(subscriptions).toHaveLength(13)
      expect(subscription().unsubscribe).not.toHaveBeenCalled()
      emitEdges(subscription())
      expect(seen).toHaveLength(6)
      expect(peerSeen).toHaveLength(2)
      release()
      emitEdges(subscription())
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toHaveLength(6)
      expect(retainedCount()).toBe(1)
      expect(subscription().unsubscribe).toHaveBeenCalledTimes(1)
      release = peer.activate()
      await vi.advanceTimersByTimeAsync(0)
      emitEdges(subscription(13))
      expect(seen).toHaveLength(8)
      unlisten()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(retainedCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('scopes deduplicated listener disposers to their original registration', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const listener = vi.fn()
    const old = feed.subscribe(listener)
    const duplicate = feed.subscribe(listener)
    await vi.advanceTimersByTimeAsync(0)
    emitEdges(subscription())
    expect(listener).toHaveBeenCalledTimes(2)
    old()
    const fresh = feed.subscribe(listener)
    old()
    duplicate()
    emitEdges(subscription())
    expect(listener).toHaveBeenCalledTimes(4)
    fresh()
    emitEdges(subscription())
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it.each(['capability', 'open'] as const)(
    'preserves queued %s progress and rejection retry across zero-activation renewal',
    async (phase) => {
      for (const reject of [false, true]) {
        resetStructuredAgentSessionTurnCompletionFeedsForTests()
        const probe = deferred<boolean>()
        const opening = deferred<{ unsubscribe: () => void }>()
        if (phase === 'capability') {
          mocks.supportsCapability.mockReturnValueOnce(probe.promise)
        } else {
          mocks.subscribe.mockImplementationOnce((_target, emit, fail, close) => {
            subscriptions.push({ emit, fail, close, unsubscribe: vi.fn() })
            return opening.promise
          })
        }
        const feed = getStructuredAgentSessionTurnCompletionFeed({
          kind: 'environment',
          environmentId: 'queued'
        })
        let release = feed.activate()
        const seen: string[] = []
        feed.subscribe((edge) => seen.push(label(edge)))
        if (phase === 'open') {
          await vi.advanceTimersByTimeAsync(0)
        }
        const start = subscriptions.length
        const opened = { unsubscribe: vi.fn() }
        if (reject) {
          if (phase === 'capability') {
            probe.reject(new Error('probe failed'))
          } else {
            opening.reject(new Error('open failed'))
          }
          // The rejection propagates through then before catch becomes continuation C.
          await Promise.resolve()
        } else if (phase === 'capability') {
          probe.resolve(true)
        } else {
          opening.resolve(opened)
        }
        // Continuation C, renewal N, then final-release flush F.
        queueMicrotask(() => {
          release = feed.activate()
        })
        release()
        await vi.advanceTimersByTimeAsync(0)
        if (reject) {
          expect(vi.getTimerCount()).toBe(1)
          await vi.advanceTimersByTimeAsync(250)
          expect(subscriptions).toHaveLength(start + 1)
        } else {
          expect(subscriptions).toHaveLength(start + (phase === 'capability' ? 1 : 0))
          expect(opened.unsubscribe).not.toHaveBeenCalled()
        }
        emitEdges(subscription(subscriptions.length - 1))
        expect(seen).toEqual(['turn-live', 'prompt:approval-live'])
        release()
        await vi.advanceTimersByTimeAsync(0)
        if (!reject && phase === 'open') {
          expect(opened.unsubscribe).toHaveBeenCalledTimes(1)
        }
        expect(vi.getTimerCount()).toBe(0)
      }
    }
  )

  it.each([
    (value: Subscription) => value.emit({ type: 'end' }),
    (value: Subscription) => value.fail(new Error('relay gone')),
    (value: Subscription) => value.close()
  ])('preserves terminal progress during grace and fences retired callbacks', async (drop) => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    let release = feed.activate()
    const seen: string[] = []
    let off = feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)
    const retired = subscription()
    queueMicrotask(() => {
      drop(retired)
      emitEdges(retired)
    })
    queueMicrotask(() => {
      release = feed.activate()
    })
    release()
    await vi.advanceTimersByTimeAsync(250)
    expect(subscriptions).toHaveLength(2)
    expect(seen).toEqual([])
    emitEdges(subscription(1))
    expect(seen).toHaveLength(2)
    release()
    off()
    await vi.advanceTimersByTimeAsync(0)
    expect(retainedCount()).toBe(0)
    release = feed.activate()
    off = feed.subscribe((edge) => seen.push(label(edge)))
    drop(retired)
    emitEdges(retired)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(subscriptions).toHaveLength(3)
    emitEdges(subscription(2))
    expect(seen).toHaveLength(4)
    release()
    off()
  })

  it('retires pending opens, probes and queued cleanup on reset without touching replacement entries', async () => {
    const probe = deferred<boolean>()
    mocks.supportsCapability.mockReturnValueOnce(probe.promise)
    const remote = getStructuredAgentSessionTurnCompletionFeed({
      kind: 'environment',
      environmentId: 'late'
    })
    const releaseRemote = remote.activate()
    releaseRemote()
    await vi.advanceTimersByTimeAsync(0)
    remote.activate()
    probe.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriptions).toHaveLength(1)
    const opening = deferred<{ unsubscribe: () => void }>()
    mocks.subscribe.mockReturnValueOnce(opening.promise)
    const held = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    const oldRelease = held.activate()
    const listener = vi.fn()
    const oldOff = held.subscribe(listener)
    oldRelease()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    const replacement = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    const releaseReplacement = replacement.activate()
    const replacementListener = vi.fn()
    const offReplacement = replacement.subscribe(replacementListener)
    const release = held.activate()
    const off = held.subscribe(listener)
    const late = { unsubscribe: vi.fn() }
    opening.resolve(late)
    oldRelease()
    oldOff()
    releaseRemote()
    await vi.advanceTimersByTimeAsync(0)
    expect(late.unsubscribe).toHaveBeenCalledTimes(1)
    expect(retainedCount()).toBe(1)
    emitEdges(subscription(1))
    expect(subscriptions).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(replacementListener).toHaveBeenCalledTimes(2)
    release()
    off()
    emitEdges(subscription(1))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(replacementListener).toHaveBeenCalledTimes(4)
    releaseReplacement()
    offReplacement()
    await vi.advanceTimersByTimeAsync(0)
    expect(retainedCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
