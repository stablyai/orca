// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
let items: AgentJournalRenderItem[] = []
let unloadedTurnRevisions: number | undefined

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionConversationOutline: vi.fn(async () => null)
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('./use-structured-agent-session-read', () => ({
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

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: vi.fn(),
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import type {
  AgentSessionContextUsage,
  AgentSessionContextUsed
} from '../../../../shared/agent-session-context-usage'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { useStructuredAgentSession } from './use-structured-agent-session'

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

  it('shows the host whole-journal answer when the loaded page starts after the turn row', async () => {
    answerOptions([{ used: estimate(150_000), window: WINDOW }])
    const { result } = render()

    await waitFor(() =>
      expect(result.current.contextUsage).toMatchObject({
        usedTokens: 150_000,
        windowTokens: 1_000_000
      })
    )
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

  it('reads only the loaded window from a host that sends no answer', async () => {
    answerOptions([undefined])
    const { result, rerender } = render()

    await waitFor(() => expect(optionReads()).toBe(1))
    expect(result.current.contextUsage).toBeNull()
    // Without a host answer there is nothing to refresh, so a missed revision asks nothing.
    unloadedTurnRevisions = 1
    rerender()
    expect(optionReads()).toBe(1)
  })

  it('asks the host again when a live turn revision fell outside the loaded window', async () => {
    answerOptions([
      { used: estimate(150_000), window: WINDOW },
      { used: estimate(170_000), window: WINDOW }
    ])
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.contextUsage).toMatchObject({ usedTokens: 150_000 }))

    unloadedTurnRevisions = 1
    rerender()

    await waitFor(() => expect(result.current.contextUsage).toMatchObject({ usedTokens: 170_000 }))
    expect(optionReads()).toBe(2)
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
    await act(async () => replies[0](150_000))
    await waitFor(() => expect(result.current.contextUsage).toMatchObject({ usedTokens: 150_000 }))

    for (let revision = 1; revision <= 5; revision += 1) {
      unloadedTurnRevisions = revision
      rerender()
    }
    expect(optionReads()).toBe(2)
    await act(async () => replies[1](160_000))
    // The one in flight lands, and one more read covers every revision behind it.
    expect(result.current.contextUsage).toMatchObject({ usedTokens: 160_000 })
    await waitFor(() => expect(optionReads()).toBe(3))
    await act(async () => replies[2](175_000))
    expect(result.current.contextUsage).toMatchObject({ usedTokens: 175_000 })
    expect(optionReads()).toBe(3)
  })
})
