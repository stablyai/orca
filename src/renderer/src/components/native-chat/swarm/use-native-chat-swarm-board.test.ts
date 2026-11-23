// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionSwarmReadResult,
  AgentSessionSwarmTranscriptResult,
  AntigravitySwarmSnapshot
} from '../../../../../shared/agent-session/antigravity-swarm-wire'
import { useNativeChatSwarmBoard } from './use-native-chat-swarm-board'

type PendingCall = {
  method: string
  params: Record<string, unknown>
  resolve: (value: unknown) => void
}

const rpc = vi.hoisted((): { calls: PendingCall[] } => ({
  calls: []
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: (_target: unknown, method: string, params: Record<string, unknown>) =>
    new Promise((resolve) => {
      rpc.calls.push({ method, params, resolve })
    })
}))

const TARGET = { kind: 'local' } as const

function makeSnapshot(
  sessionId: string,
  stepCount: number,
  etag: string
): AntigravitySwarmSnapshot {
  return {
    swarmId: `swarm-${sessionId}`,
    title: `Swarm ${sessionId}`,
    headSeq: 1,
    channels: ['main'],
    plan: null,
    etag,
    messages: [],
    members: [
      {
        name: 'worker-1',
        conversationId: 'conv-1',
        model: 'gemini',
        role: 'worker',
        wakeMode: 'auto',
        status: 'working',
        waitSince: 0,
        lastReadSeq: 0,
        unread: 0,
        killed: false,
        worktree: null,
        channels: ['main'],
        steps: stepCount,
        activity: '',
        activityKind: '',
        replied: false,
        failure: null,
        posts: 0,
        lastPostSeq: 0,
        lastPostTime: '',
        lastPostTs: null,
        transcriptMtime: stepCount * 100
      }
    ]
  }
}

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run()
    await Promise.resolve()
  })
}

function nextCall(method: string): PendingCall {
  const index = rpc.calls.findIndex((call) => call.method === method)
  if (index === -1) {
    throw new Error(`Expected pending call for ${method}`)
  }
  return rpc.calls.splice(index, 1)[0]!
}

describe('useNativeChatSwarmBoard', () => {
  beforeEach(() => {
    rpc.calls = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the cached ETag when switching to a session with no swarm so returning reloads the snapshot', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useNativeChatSwarmBoard({
          agent: 'antigravity',
          sessionId,
          target: TARGET,
          isVisible: true,
          isWorking: true
        }),
      { initialProps: { sessionId: 'session-a' } }
    )

    const snapA = makeSnapshot('session-a', 1, 'etag-a')
    await settle(() => {
      nextCall('agentSession.swarmRead').resolve({
        status: 'ok',
        snapshot: snapA
      } satisfies AgentSessionSwarmReadResult)
    })
    expect(result.current.snapshot?.swarmId).toBe('swarm-session-a')

    // Becoming snapshot-backed restarts the poll effect with the active ETag.
    const pollA = nextCall('agentSession.swarmRead')
    expect(pollA.params).toEqual({ sessionId: 'session-a', ifNoneMatch: 'etag-a' })
    await settle(() => {
      pollA.resolve({ status: 'unchanged', etag: 'etag-a' } satisfies AgentSessionSwarmReadResult)
    })

    rerender({ sessionId: 'session-b' })
    const readB = nextCall('agentSession.swarmRead')
    expect(readB.params).toEqual({ sessionId: 'session-b' })
    await settle(() => {
      readB.resolve({ status: 'none' } satisfies AgentSessionSwarmReadResult)
    })
    expect(result.current.snapshot).toBeNull()

    rerender({ sessionId: 'session-a' })
    const readAAgain = nextCall('agentSession.swarmRead')
    expect(readAAgain.params).toEqual({ sessionId: 'session-a' })
    await settle(() => {
      readAAgain.resolve({
        status: 'ok',
        snapshot: snapA
      } satisfies AgentSessionSwarmReadResult)
    })
    expect(result.current.snapshot?.swarmId).toBe('swarm-session-a')
  })

  it('applies slow in-flight transcript reads, coalesces stamp updates, and discards reads after switching members', async () => {
    const { result } = renderHook(() =>
      useNativeChatSwarmBoard({
        agent: 'antigravity',
        sessionId: 'session-a',
        target: TARGET,
        isVisible: true,
        isWorking: true
      })
    )

    await settle(() => {
      nextCall('agentSession.swarmRead').resolve({
        status: 'ok',
        snapshot: makeSnapshot('session-a', 1, 'etag-1')
      } satisfies AgentSessionSwarmReadResult)
    })

    act(() => {
      result.current.open()
    })
    await settle(() => {
      nextCall('agentSession.swarmRead').resolve({
        status: 'ok',
        snapshot: makeSnapshot('session-a', 1, 'etag-1')
      } satisfies AgentSessionSwarmReadResult)
    })

    act(() => {
      result.current.selectMemberConversation('conv-1')
    })

    const firstTranscriptRead = nextCall('agentSession.swarmMemberTranscript')
    expect(firstTranscriptRead.params).toMatchObject({ conversationId: 'conv-1' })

    // Two poll ticks arrive while the first transcript read is still in flight.
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    await settle(() => {
      nextCall('agentSession.swarmRead').resolve({
        status: 'ok',
        snapshot: makeSnapshot('session-a', 2, 'etag-2')
      } satisfies AgentSessionSwarmReadResult)
    })
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    await settle(() => {
      nextCall('agentSession.swarmRead').resolve({
        status: 'ok',
        snapshot: makeSnapshot('session-a', 3, 'etag-3')
      } satisfies AgentSessionSwarmReadResult)
    })

    // In-flight read was not dropped; only one coalesced follow-up starts after it settles.
    expect(rpc.calls.filter((c) => c.method === 'agentSession.swarmMemberTranscript')).toHaveLength(
      0
    )

    await settle(() => {
      firstTranscriptRead.resolve({
        status: 'ok',
        conversationId: 'conv-1',
        entries: [{ stepIndex: 1, kind: 'assistant', text: 'step-1', toolCalls: [] }],
        truncated: false
      } satisfies AgentSessionSwarmTranscriptResult)
    })

    expect(result.current.transcript).toMatchObject({
      status: 'ok',
      conversationId: 'conv-1',
      entries: [{ stepIndex: 1, text: 'step-1' }]
    })

    const coalescedRead = nextCall('agentSession.swarmMemberTranscript')
    expect(coalescedRead.params).toMatchObject({ conversationId: 'conv-1' })

    // Switching away before the coalesced read resolves discards its result.
    act(() => {
      result.current.selectMemberConversation('conv-2')
    })
    const conv2Read = nextCall('agentSession.swarmMemberTranscript')
    expect(conv2Read.params).toMatchObject({ conversationId: 'conv-2' })

    await settle(() => {
      coalescedRead.resolve({
        status: 'ok',
        conversationId: 'conv-1',
        entries: [{ stepIndex: 3, kind: 'assistant', text: 'stale-conv-1', toolCalls: [] }],
        truncated: false
      } satisfies AgentSessionSwarmTranscriptResult)
    })
    expect(result.current.transcript).toBeNull()

    await settle(() => {
      conv2Read.resolve({
        status: 'ok',
        conversationId: 'conv-2',
        entries: [{ stepIndex: 1, kind: 'assistant', text: 'conv-2-step', toolCalls: [] }],
        truncated: false
      } satisfies AgentSessionSwarmTranscriptResult)
    })
    expect(result.current.transcript).toMatchObject({
      status: 'ok',
      conversationId: 'conv-2',
      entries: [{ stepIndex: 1, text: 'conv-2-step' }]
    })
  })
})
