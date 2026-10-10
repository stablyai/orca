// @vitest-environment happy-dom

// A chat on a paired server belongs to that server: its reads (history, live updates, rail outline),
// writes, and the capability questions behind them go to it, never to this machine. The server here advertises today's capabilities and this machine
// advertises none, so a question asked of the wrong runtime changes what is sent.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  hostCapabilities: new Map<string, readonly string[]>()
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: mocks.call,
  // The sender checks compatibility itself before its send goes out.
  ensureRuntimeEnvironmentCompatible: async () => undefined,
  runtimeEnvironmentSupportsCapability: async (environmentId: string, capability: string) =>
    mocks.hostCapabilities.get(environmentId)?.includes(capability) === true
}))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  subscribeStructuredAgentSession: mocks.subscribe
}))

import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session-stop-capabilities'
import {
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import {
  useStructuredAgentSession,
  type StructuredPromptItem
} from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const FENCE: Record<string, number> = { local: 7, 'server-1': 3 }

const question: StructuredPromptItem = {
  itemId: 'question-1',
  revision: 2,
  sequence: 2,
  observedAt: 2,
  body: {
    kind: 'question',
    question: 'Which option?',
    options: [],
    questions: [
      {
        id: 'q1',
        question: 'Which option?',
        multiSelect: false,
        options: [{ id: 'q1:choice-1', label: 'Alpha' }],
        freeTextQuestionId: 'q1'
      }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}
const answers = [{ questionId: 'q1', optionIds: [], other: 'Beta' }]

function runtimeOf(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : target.environmentId
}

let olderHistoryUnloaded = false

function historyPage(target: RuntimeClientTarget): AgentSessionHistoryPage {
  const cursor = (sequence: number): AgentJournalCursor => ({ epoch: 'epoch-a', sequence })
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items: olderHistoryUnloaded
      ? [
          {
            itemId: 'turn-0',
            revision: 1,
            sequence: 5,
            observedAt: 5,
            body: { kind: 'turn', turnId: 'turn-0', state: 'completed' }
          }
        ]
      : [],
    removedItemIds: [],
    submissions: [],
    window: olderHistoryUnloaded
      ? { oldest: cursor(5), newest: cursor(5), nextCursor: cursor(6) }
      : { oldest: null, newest: null, nextCursor: cursor(0) },
    liveCursor: cursor(olderHistoryUnloaded ? 6 : 0),
    hasOlder: olderHistoryUnloaded,
    hasNewer: false,
    fence: FENCE[runtimeOf(target)]
  }
}

function render(target: RuntimeClientTarget) {
  return renderHook(() =>
    useStructuredAgentSession({ sessionId: 'session-a', target, agent: 'claude', isVisible: true })
  )
}

function calls(method: string): { target: RuntimeClientTarget; params: Record<string, unknown> }[] {
  return mocks.call.mock.calls
    .filter(([, called]) => called === method)
    .map(([target, , params]) => ({ target, params }))
}

describe('a structured chat on a paired server', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    localStorage.clear()
    olderHistoryUnloaded = false
    mocks.hostCapabilities.clear()
    mocks.hostCapabilities.set('server-1', RUNTIME_CAPABILITIES)
    setLocalRuntimeCapabilitiesForTests([])
    mocks.call.mockImplementation(async (target: RuntimeClientTarget, method: string) => {
      if (method === 'agentSession.history') {
        return { ok: true, page: historyPage(target) }
      }
      return {
        ok: true,
        value: method === 'agentSession.send' ? { queued: {} } : { applied: true }
      }
    })
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  it('advertises every capability these actions ask about', () => {
    expect(RUNTIME_CAPABILITIES).toEqual(
      expect.arrayContaining([
        AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
        AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
        AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
        AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
      ])
    )
  })

  it('reads, sends, stops, answers, and releases through the server', async () => {
    const unsubscribe = vi.fn()
    mocks.subscribe.mockResolvedValue({ unsubscribe })
    const { result, unmount } = render(PAIRED_TARGET)
    await waitFor(() => expect(calls('agentSession.history')).not.toHaveLength(0))

    act(() => {
      result.current.send('hello')
    })
    await waitFor(() =>
      expect(calls('agentSession.send')).toContainEqual({
        target: PAIRED_TARGET,
        params: expect.objectContaining({
          envelope: expect.objectContaining({ sessionId: 'session-a', expectedRuntimeFence: 3 })
        })
      })
    )

    // Only the server takes a Stop that names no turn; this machine would leave nothing to stop.
    await waitFor(async () => {
      await act(async () => {
        await result.current.stop()
      })
      expect(calls('agentSession.cancel')).toHaveLength(1)
    })
    expect(calls('agentSession.cancel')[0].params).not.toHaveProperty('turnId')

    // The server keeps a repeated Stop quiet, so two presses both go out instead of joining.
    await act(async () => {
      await Promise.all([result.current.cancel('turn-1'), result.current.cancel('turn-1')])
    })
    expect(calls('agentSession.cancel').filter(({ params }) => params.turnId)).toHaveLength(2)

    await act(async () => {
      await result.current.cancel('turn-1', { itemId: 'question-1', expectedRevision: 2 })
    })
    expect(calls('agentSession.cancel').at(-1)?.params).toMatchObject({
      turnId: 'turn-1',
      prompt: { itemId: 'question-1', expectedRevision: 2 }
    })

    await act(async () => {
      await result.current.respond(question, { kind: 'answers', answers })
    })
    expect(calls('agentSession.respondToQuestion')).toEqual([
      { target: PAIRED_TARGET, params: expect.objectContaining({ answers }) }
    ])

    unmount()
    await waitFor(() =>
      expect(calls('agentSession.release')).toContainEqual({
        target: PAIRED_TARGET,
        params: expect.anything()
      })
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.subscribe).toHaveBeenCalledWith(
      PAIRED_TARGET,
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    )
    expect(mocks.subscribe.mock.calls.every(([target]) => target === PAIRED_TARGET)).toBe(true)
    expect(mocks.call.mock.calls.every(([target]) => target === PAIRED_TARGET)).toBe(true)
  })

  // The rail asks for the outline only while older history is unloaded.
  it("reads the rail's conversation outline from the server", async () => {
    olderHistoryUnloaded = true
    render(PAIRED_TARGET)

    await waitFor(() =>
      expect(calls('agentSession.conversationOutline')).toEqual([
        { target: PAIRED_TARGET, params: { sessionId: 'session-a' } }
      ])
    )
  })

  it('keeps a local session apart from a paired session with the same id', async () => {
    const paired = render(PAIRED_TARGET)
    const local = render(LOCAL_TARGET)

    for (const [view, target] of [
      [paired, PAIRED_TARGET],
      [local, LOCAL_TARGET]
    ] as const) {
      await waitFor(() =>
        expect(calls('agentSession.history').map((call) => call.target)).toContain(target)
      )
      expect(mocks.subscribe.mock.calls.map(([subscribed]) => subscribed)).toContain(target)
      await act(async () => {
        await view.result.current.cancel('turn-1')
      })
      expect(calls('agentSession.cancel').at(-1)).toEqual({
        target,
        params: expect.objectContaining({
          envelope: expect.objectContaining({ expectedRuntimeFence: FENCE[runtimeOf(target)] })
        })
      })
    }
  })
})
