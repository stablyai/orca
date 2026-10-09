// @vitest-environment happy-dom

// A /clear against a host that runs it from the queue (`agent-session.queued-clear.v1`): the
// session controller asks it to wait only where the host can hold it, and a waiting /clear card
// queues later sends.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionQueuedMessage,
  AgentSessionQueueWait
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  sendArgs: Array.of<{ queue?: { capability: string; enabled: boolean } }>(),
  operations: 0
}))
let items: AgentJournalRenderItem[] = []
let queuedMessages: AgentSessionQueuedMessage[] | undefined
let nextQueuedMessageId: string | null = null
let nextQueuedMessageWait: AgentSessionQueueWait | null = null
let pending: StructuredAgentSessionPendingSend[] = []
let backgroundTasks: AgentSessionBackgroundTaskState | null = null

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      ...(queuedMessages !== undefined ? { queuedMessages } : {}),
      nextQueuedMessageId,
      nextQueuedMessageWait,
      backgroundTasks
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: (args: { queue?: { capability: string; enabled: boolean } }) => {
    mocks.sendArgs.push(args)
    return { pending, error: null, send: vi.fn(), stopSends: vi.fn() }
  }
}))

import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { ConversationCommandParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import { useStructuredAgentSession } from './use-structured-agent-session'

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

function draft(id: string): AgentSessionQueuedMessage {
  return {
    messageId: id,
    position: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `queued ${id}` }] },
    state: 'waiting'
  }
}

function render(queueFollowUps?: boolean) {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'claude',
      target: { kind: 'local' },
      isVisible: true,
      composerScopeKey: 'scope-1',
      ...(queueFollowUps === undefined ? {} : { queueFollowUps })
    })
  )
}

function commandCalls(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.conversationCommand')
    .map(([, , params]) => params)
}

function answerCommands(value: Record<string, unknown>): void {
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.conversationCommand'
      ? { ok: true, replayed: false, fence: 3, cursor: { epoch: 'e', sequence: 1 }, value }
      : null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendArgs.length = 0
  mocks.call.mockImplementation(async () => null)
  items = [RUNNING_TURN]
  queuedMessages = undefined
  nextQueuedMessageId = null
  nextQueuedMessageWait = null
  pending = []
  backgroundTasks = null
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('a /clear against a host that runs it from the queue', () => {
  const CLEAR_WAITS = [
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY
  ]
  const queuedClearAnswer = {
    command: 'clear',
    state: 'completed',
    queued: { messageId: 'operation-1', position: 1, state: 'waiting' }
  }

  it('mid-turn, goes to the host asking to wait, and its queued answer shows no notice', async () => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    answerCommands(queuedClearAnswer)
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({ accepted: true, error: null })
    const parsed = ConversationCommandParams.parse(commandCalls()[0])
    expect(parsed).toMatchObject({ command: 'clear', delivery: 'queue-if-active' })
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: 'clear', delivery: 'queue-if-active' }
      })
    )
  })

  it('against a host that holds only /compact, keeps the refusal and never asks (temporary)', async () => {
    // Every capability but the last, queued-clear.
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS.slice(0, -1))
    answerCommands(queuedClearAnswer)
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    // Its line stands only while the agent works, as every command refusal's does.
    expect(outcome).toEqual({
      accepted: false,
      error: "The agent is still working. Run /clear when it's done.",
      refusedWhile: 'working'
    })
    expect(commandCalls()).toHaveLength(0)
  })

  it.each([
    { card: 'waiting', held: false, enabled: true },
    { card: 'held (couldn’t send), which the queue skips', held: true, enabled: false }
  ])('a $card /clear card decides whether a send queues behind it', ({ held, enabled }) => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    queuedMessages = [
      {
        ...draft('clear-1'),
        body: { ...draft('clear-1').body, command: { name: 'clear' } },
        ...(held ? { paused: true as const, pausedReason: 'send_failed' as const } : {})
      }
    ]
    render(false)
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({ capability: 'supported', enabled })
  })

  it('held by the host on background tasks once the turn ended: says so, offers no Send, chat idle', () => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    items = []
    backgroundTasks = { state: 'monitoring', tasks: [{ id: 'task-1', kind: 'command' }] }
    queuedMessages = [
      { ...draft('clear-1'), body: { ...draft('clear-1').body, command: { name: 'clear' } } },
      { ...draft('after-1'), position: 2 }
    ]
    // The host publishes the wait, not a next send: nothing runs, so the chat is not busy.
    nextQueuedMessageWait = { messageId: 'clear-1', reason: 'background-tasks' }
    const { result } = render()
    // The strip offers its stop-all for these tasks, so the caption names it.
    expect(result.current.queuedMessages.cards[0]).toMatchObject({
      messageId: 'clear-1',
      hold: 'background-tasks-stoppable',
      runsOnItsOwn: true
    })
    expect(result.current.isWorking).toBe(false)
  })

  it('a message sent while it waits is a sending card at once, never a transcript bubble', () => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    items = []
    queuedMessages = [
      { ...draft('clear-1'), body: { ...draft('clear-1').body, command: { name: 'clear' } } }
    ]
    nextQueuedMessageWait = { messageId: 'clear-1', reason: 'background-tasks' }
    pending = [
      {
        clientMessageId: 'sent-1',
        sessionId: 'session-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'after' }] },
        previewUris: [],
        queuedAt: 1,
        delivery: 'queue-if-active',
        phase: 'sending',
        issued: true
      }
    ]
    const { result } = render()
    expect(JSON.stringify(result.current.messages)).not.toContain('sent-1')
    expect(result.current.queuedMessages.cards.at(-1)).toMatchObject({
      messageId: 'sent-1',
      hold: 'sending'
    })
  })

  it('held with nothing published (after a reopen) keeps Send, as /compact does', () => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    items = []
    queuedMessages = [
      { ...draft('clear-1'), body: { ...draft('clear-1').body, command: { name: 'clear' } } }
    ]
    const { result } = render()
    expect(result.current.queuedMessages.cards[0]?.runsOnItsOwn).toBeUndefined()
    expect(result.current.queuedMessages.cards[0]?.waitsForAgent).toBeUndefined()
  })

  it('without the queue lit, keeps the refusal even when the host could hold it', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY])
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toMatchObject({ accepted: false })
    expect(commandCalls()).toHaveLength(0)
  })
})
