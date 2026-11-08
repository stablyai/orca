// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
let items: AgentJournalRenderItem[] = []
let unloadedTurnRevisions: number | undefined

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('../../../runtime/native-chat/journal/structured-agent-session-journal-reads', () => ({
  readStructuredAgentSessionConversationOutline: vi.fn(async () => null)
}))

vi.mock('../session/options/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('../session/structured/read/use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: true,
      handoff: null,
      unloadedTurnRevisions
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('../session/structured/writes/structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: vi.fn()
}))
vi.mock('../session/structured/delivery/use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: vi.fn(),
    stopSends: vi.fn()
  })
}))

import type {
  AgentSessionContextUsage,
  AgentSessionContextUsed
} from '../../../../../shared/agent-session/agent-session-context-usage'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { useStructuredAgentSession } from '../session/structured/use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const
const WINDOW = { tokens: 1_000_000, capturedAt: 1 }

function estimate(inputTokens: number): AgentSessionContextUsed {
  return {
    kind: 'estimate',
    usage: { inputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 },
    capturedAt: 1
  }
}

function turnRow(sequence: number, contextUsage: AgentSessionContextUsage): AgentJournalRenderItem {
  return {
    itemId: `turn-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId: `turn-${sequence}`, state: 'completed', contextUsage }
  }
}

const messageRow = (sequence: number): AgentJournalRenderItem => ({
  itemId: `message-${sequence}`,
  revision: 1,
  sequence,
  observedAt: sequence,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] }
})

function answerOptions(answers: (AgentSessionContextUsage | undefined)[]): void {
  let reads = 0
  mocks.call.mockImplementation((_target, method) => {
    if (method !== 'agentSession.options') {
      return Promise.resolve(null)
    }
    const current = answers[Math.min(reads, answers.length - 1)]
    reads += 1
    return Promise.resolve({
      models: [],
      current: { model: 'opus' },
      ...(current ? { contextUsage: { current } } : {})
    })
  })
}

const optionReads = (): number =>
  mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length

function render() {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'claude',
      target: LOCAL_TARGET,
      isVisible: true
    })
  )
}

describe('useStructuredAgentSession context usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    items = [messageRow(900)]
    unloadedTurnRevisions = undefined
  })

  it('prefers the loaded window when it holds a newer turn fact', async () => {
    // The window part is only on an older row, so a full reading needs the host answer applied.
    items = [turnRow(900, { used: estimate(180_000) })]
    answerOptions([{ used: estimate(150_000), window: WINDOW }])
    const { result } = render()

    await waitFor(() =>
      expect(result.current.contextUsage).toMatchObject({
        usedTokens: 180_000,
        windowTokens: 1_000_000
      })
    )
  })

  it('keeps one refresh in flight and one behind it however many revisions it missed', async () => {
    const replies: ((used: number) => void)[] = []
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? new Promise((resolve) =>
            replies.push((used) =>
              resolve({
                models: [],
                current: { model: 'opus' },
                contextUsage: { current: { used: estimate(used), window: WINDOW } }
              })
            )
          )
        : Promise.resolve(null)
    )
    const { result, rerender } = render()
    // Reads start one microtask after they are scheduled, so let each start before its revisions.
    await waitFor(() => expect(replies).toHaveLength(1))
    await act(async () => replies[0](150_000))
    await waitFor(() => expect(result.current.contextUsage).toMatchObject({ usedTokens: 150_000 }))

    unloadedTurnRevisions = 1
    rerender()
    await waitFor(() => expect(optionReads()).toBe(2))
    for (let revision = 2; revision <= 5; revision += 1) {
      unloadedTurnRevisions = revision
      rerender()
    }
    expect(optionReads()).toBe(2)
    await act(async () => replies[1](160_000))
    // The obsolete read cannot replace the answer; one current successor covers the revisions.
    expect(result.current.contextUsage).toMatchObject({ usedTokens: 150_000 })
    await waitFor(() => expect(optionReads()).toBe(3))
    await act(async () => replies[2](175_000))
    expect(result.current.contextUsage).toMatchObject({ usedTokens: 175_000 })
    expect(optionReads()).toBe(3)
  })
})
