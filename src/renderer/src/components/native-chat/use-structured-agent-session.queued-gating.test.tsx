// @vitest-environment happy-dom

// Capability gating for mid-turn queueing at the session controller: only a
// host advertising `agent-session.queued-messages.v1` gets `delivery` or the
// card RPCs — anything older sees exactly today's client. Stop and /clear are
// today's plain writes for every host: drafts are never withdrawn by either,
// and no draft text ever rides an answer. A host-held draft is a card above
// the composer, never a transcript bubble.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type * as RewindModule from './use-native-chat-rewind'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  sendArgs: Array.of<{ queue?: { capability: string; enabled: boolean } }>(),
  operations: 0,
  rewindPending: false
}))
let items: AgentJournalRenderItem[] = []
let queuedMessages: AgentSessionQueuedMessage[] | undefined
let submissions: AgentJournalSubmission[] = []
let nextQueuedMessageId: string | null = null
let pendingSends: StructuredAgentSessionPendingSend[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
      submissions,
      status: 'ready',
      error: null,
      hasOlder: false,
      ...(queuedMessages !== undefined ? { queuedMessages, nextQueuedMessageId } : {})
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

// The real rewind hook, with only its in-flight latch forced when a test says so.
vi.mock('./use-native-chat-rewind', async (importOriginal) => {
  const actual = await importOriginal<typeof RewindModule>()
  return {
    ...actual,
    useStructuredAgentSessionRewind: (
      ...args: Parameters<typeof actual.useStructuredAgentSessionRewind>
    ) => {
      const rewind = actual.useStructuredAgentSessionRewind(...args)
      return mocks.rewindPending ? { ...rewind, blockedRef: { current: true } } : rewind
    }
  }
})

vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: (args: { queue?: { capability: string; enabled: boolean } }) => {
    mocks.sendArgs.push(args)
    return {
      pending: pendingSends,
      error: null,
      send: vi.fn(),
      stopSends: vi.fn()
    }
  }
}))

import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { ConversationCommandParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

/** A pending approval; one of a subject kind this build does not know cannot be answered here. */
function approval(subject: Record<string, unknown>): AgentJournalRenderItem {
  return JSON.parse(
    JSON.stringify({
      itemId: `approval-${String(subject.kind)}`,
      revision: 1,
      sequence: 2,
      observedAt: 1,
      body: {
        kind: 'approval',
        title: 'Review',
        detail: null,
        subject,
        options: [{ id: 'allow', label: 'Approve' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    })
  )
}

const newerApproval = (): AgentJournalRenderItem => approval({ kind: 'diff', path: 'a.ts' })

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

function cancels(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.cancel')
    .map(([, , params]) => params)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendArgs.length = 0
  mocks.rewindPending = false
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.cancel'
      ? {
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'e', sequence: 1 },
          value: { cancelled: true }
        }
      : null
  )
  items = [RUNNING_TURN]
  queuedMessages = undefined
  submissions = []
  nextQueuedMessageId = null
  pendingSends = []
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('against a capable host', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
    ])
  })

  it('queues sends while the setting is on, immediately when it is off', () => {
    render()
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({
      capability: 'supported',
      enabled: true
    })
    mocks.sendArgs.length = 0
    render(false)
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({
      capability: 'supported',
      enabled: false
    })
  })

  // While a Stop runs, the composer says what a send made now does: queued after the stop, or sent.
  describe('the words for a send after a Stop', () => {
    const afterStop = (queueFollowUps?: boolean) => {
      const { result } = render(queueFollowUps)
      return nativeChatStructuredStopControls(result.current, true).composer.afterStop
    }

    it('say it queues while the setting is on', () => {
      expect(afterStop()).toBe('queue')
    })

    it('say it is sent while the setting is off, though the host queues', () => {
      expect(afterStop(false)).toBe('send')
    })

    it('say it is sent while every pending prompt is one this build cannot answer', () => {
      items = [RUNNING_TURN, newerApproval()]
      expect(afterStop()).toBe('send')
    })
  })

  // The host's queue would hold a send behind a prompt nothing here can settle.
  it('sends immediately while every pending prompt is one this build cannot answer', () => {
    const newer = newerApproval()
    items = [newer]
    render()
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({
      capability: 'supported',
      enabled: false
    })
    mocks.sendArgs.length = 0
    items = [newer, approval({ kind: 'plan', text: 'do it' })]
    render()
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({
      capability: 'supported',
      enabled: true
    })
  })

  it('Stop is a plain cancel: drafts stay as cards and no text lands in the composer', async () => {
    queuedMessages = [{ ...draft('draft-1'), paused: true }]
    const { result } = render(false)
    await act(async () => {
      await result.current.stop()
    })
    const [params] = cancels()
    expect(params).toBeDefined()
    expect(params).not.toHaveProperty('withdrawQueued')
    // The host still owns the draft; the client shows it paused and restores nothing.
    expect(result.current.queuedMessages.cards).toMatchObject([
      { messageId: 'draft-1', hold: 'paused' }
    ])
    expect(readNativeChatDraftCache('scope-1')).toBe('')
  })

  it("/clear is exactly today's command — drafts are the host's to carry", async () => {
    items = []
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.conversationCommand'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { command: 'clear', state: 'completed' }
          }
        : null
    )
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    const clearCall = mocks.call.mock.calls.find(
      ([, method]) => method === 'agentSession.conversationCommand'
    )
    // The host's REAL strict schema accepts the request as sent — and it carries
    // no withdraw key: the host moves the drafts to the replacement session itself.
    const parsed = ConversationCommandParams.parse(clearCall?.[2])
    expect(parsed.command).toBe('clear')
    expect('withdrawQueued' in parsed).toBe(false)
    // Fingerprint parity with the host's digest; a mismatch would refuse the
    // operation at admission.
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: parsed.command }
      })
    )
  })

  // The host finds an earlier /clear from its own journal, so the client keeps no id for it.
  it("an unconfirmed /clear's next press goes out under its own id", async () => {
    items = []
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.conversationCommand'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { command: 'clear', state: 'unknown' }
          }
        : null
    )
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    const ids = mocks.call.mock.calls
      .filter(([, method]) => method === 'agentSession.conversationCommand')
      .map(([, , params]) => ConversationCommandParams.parse(params).envelope.clientOperationId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('a mid-turn queue send is never a transcript bubble, before or after the host holds it', () => {
    const entry = (
      id: string,
      text: string,
      delivery?: 'queue-if-active'
    ): StructuredAgentSessionPendingSend => ({
      clientMessageId: id,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      ...(delivery ? { delivery } : {})
    })
    pendingSends = [
      // On its way asking to be queued: its card, not a bubble, shows it.
      entry('pending-queue', 'awaiting the answer', 'queue-if-active'),
      // Sent plain: a bubble.
      entry('plain', 'immediate send')
    ]
    const working = render()
    const workingText = JSON.stringify(working.result.current.messages)
    expect(workingText).not.toContain('awaiting the answer')
    expect(workingText).toContain('immediate send')
    // The host already publishes it as a draft: the card alone shows it, whatever the turn.
    items = []
    queuedMessages = [draft('pending-queue')]
    const idle = render()
    expect(JSON.stringify(idle.result.current.messages)).not.toContain('awaiting the answer')
    queuedMessages = undefined
    const idleUnheld = render()
    expect(JSON.stringify(idleUnheld.result.current.messages)).toContain('awaiting the answer')
  })

  it('reads as working while the host names the card its queue sends next, with nothing to stop yet', () => {
    // A turn just ended; the queue's send of `draft-1` is the host's next update.
    items = []
    queuedMessages = [draft('draft-1')]
    nextQueuedMessageId = 'draft-1'
    const { result } = render()
    expect(result.current).toMatchObject({ isWorking: true, queueSendsNext: true, canStop: false })
    expect(result.current.queuedMessages.cards.map((card) => card.hold)).toEqual(['turn'])
    // A command refused now is said while the pane reads working, and no longer.
    expect(result.current.commandRefusalCauses.working).toBe(true)
    // Where the host would refuse that send, it names none: the chat reads idle.
    nextQueuedMessageId = null
    const refused = render()
    expect(refused.result.current).toMatchObject({ isWorking: false, queueSendsNext: false })
    expect(refused.result.current.commandRefusalCauses.working).toBe(false)
  })

  it('shows host-held drafts as cards, never as transcript bubbles', () => {
    queuedMessages = [draft('draft-1')]
    const { result } = render()
    expect(result.current.queuedMessages.cards.map((card) => card.text)).toEqual(['queued draft-1'])
    const transcriptText = JSON.stringify(result.current.messages)
    expect(transcriptText).not.toContain('queued draft-1')
  })
})

function commandCalls(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.conversationCommand')
    .map(([, , params]) => params)
}

function answerCommands(value: Record<string, unknown>): void {
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.conversationCommand'
      ? { ok: true, replayed: false, fence: 3, cursor: { epoch: 'e', sequence: 1 }, value }
      : method === 'agentSession.cancel'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { cancelled: true }
          }
        : null
  )
}

describe('a /compact against a host that holds commands in line', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
    ])
  })

  it('mid-turn, goes to the host asking to wait, and its queued answer shows no notice', async () => {
    answerCommands({
      command: 'compact',
      state: 'completed',
      queued: { messageId: 'operation-1', position: 1, state: 'waiting' }
    })
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({ accepted: true, error: null })
    const parsed = ConversationCommandParams.parse(commandCalls()[0])
    expect(parsed).toMatchObject({ command: 'compact', delivery: 'queue-if-active' })
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: 'compact', delivery: 'queue-if-active' }
      })
    )
  })

  function unsent(
    id: string,
    overrides: Partial<StructuredAgentSessionPendingSend> = {}
  ): StructuredAgentSessionPendingSend {
    return {
      clientMessageId: id,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `message ${id}` }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      ...overrides
    }
  }

  it('behind a message still on its way: Send is busy, the message reads Sending, nothing is armed', async () => {
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    pendingSends = [unsent('on-its-way')]
    const { result, rerender } = render()
    // The composer's send control is Stop while a send is on its way: the existing busy state.
    expect(result.current.canStop).toBe(true)
    // Its row reads "Sending…" (`NativeChatMessageRow`), from the same outbox.
    expect(
      structuredAgentSessionDeliveryNotices({
        pending: pendingSends,
        agentName: 'Claude',
        submissions: [],
        startFailures: []
      }).get(agentJournalSubmissionKey('on-its-way'))
    ).toEqual({ sending: true })
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({ accepted: false, error: null })
    // The host has it now: nothing goes out on its own; the next press does.
    pendingSends = []
    rerender()
    expect(commandCalls()).toHaveLength(0)
    expect(result.current.canStop).toBe(false)
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({ accepted: true, error: null })
    expect(commandCalls()).toHaveLength(1)
  })

  it('Stop settles the pending send and leaves no command armed behind it', async () => {
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    pendingSends = [unsent('on-its-way')]
    const { result, rerender } = render()
    await act(async () => {
      expect(await result.current.runConversationCommand('compact')).toEqual({
        accepted: false,
        error: null
      })
      await result.current.stop()
    })
    pendingSends = []
    rerender()
    expect(result.current.canStop).toBe(false)
    expect(commandCalls()).toHaveLength(0)
    await act(async () => {
      expect(await result.current.runConversationCommand('compact')).toEqual({
        accepted: true,
        error: null
      })
    })
  })

  it('mid-turn, behind a queue send on its way: it reads Sending as a card, and nothing is armed', async () => {
    answerCommands({ command: 'compact', state: 'completed' })
    pendingSends = [
      unsent('on-its-way', {
        delivery: 'queue-if-active'
      })
    ]
    const { result } = render()
    // Not a transcript bubble mid-turn; the card it is about to become reads as sending.
    expect(JSON.stringify(result.current.messages)).not.toContain('message on-its-way')
    expect(result.current.queuedMessages.cards).toEqual([
      expect.objectContaining({
        messageId: 'on-its-way',
        text: 'message on-its-way',
        hold: 'sending'
      })
    ])
    await act(async () => {
      expect(await result.current.runConversationCommand('compact')).toEqual({
        accepted: false,
        error: null
      })
    })
    expect(commandCalls()).toHaveLength(0)
  })

  it('an idle send the host has recorded is its transcript row only, never a sending card too', () => {
    items = []
    pendingSends = [
      unsent('recorded', {
        delivery: 'queue-if-active'
      })
    ]
    // The host took it straight through: its own submission, unanswered, makes the chat working.
    submissions = [
      {
        clientMessageId: 'recorded',
        fence: 3,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 2,
        resolvedAt: null,
        handoverRecorded: true,
        handedOverAt: 3
      }
    ]
    const { result } = render()
    expect(result.current.isWorking).toBe(true)
    expect(result.current.queuedMessages.cards).toEqual([])
  })

  it('/clear right after a Stop kept a send on its way names no Retry it does not show', async () => {
    items = []
    pendingSends = [
      unsent('kept', {
        delivery: 'queue-if-active'
      })
    ]
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: 'Your earlier message is still being sent. Run /clear once it has gone.',
      refusedWhile: 'sending'
    })
  })

  it('/clear with the agent idle behind its own unsent message says it is still being sent', async () => {
    items = []
    pendingSends = [unsent('on-its-way')]
    const { result, rerender } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: 'Your earlier message is still being sent. Run /clear once it has gone.',
      refusedWhile: 'sending'
    })
    expect(commandCalls()).toHaveLength(0)
    // A failed send returns to the composer and no longer blocks another command.
    pendingSends = []
    rerender()
    expect(result.current.commandRefusalCauses).toMatchObject({ sending: false, retry: false })
  })

  it('a recorded message no longer blocks /clear or /compact', async () => {
    items = []
    pendingSends = [unsent('recorded', { phase: 'recorded' })]
    const { result } = render()
    for (const command of ['clear', 'compact'] as const) {
      answerCommands({ command, state: 'completed' })
      await act(async () => {
        expect(await result.current.runConversationCommand(command)).toEqual({
          accepted: true,
          error: null
        })
      })
    }
    expect(commandCalls()).toHaveLength(2)
    expect(result.current.commandRefusalCauses).toMatchObject({ sending: false, retry: false })
  })

  it('/clear mid-turn is still refused here, and never asks to wait', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    expect(commandCalls()).toHaveLength(0)
    items = []
    answerCommands({ command: 'clear', state: 'completed' })
    const idle = render()
    await act(async () => {
      await idle.result.current.runConversationCommand('clear')
    })
    expect(ConversationCommandParams.parse(commandCalls()[0])).not.toHaveProperty('delivery')
  })

  it('a rewind on its way holds /clear and /compact alike, in the same words, and writes nothing', async () => {
    items = []
    mocks.rewindPending = true
    const { result } = render()
    for (const command of ['clear', 'compact'] as const) {
      let outcome: unknown
      await act(async () => {
        outcome = await result.current.runConversationCommand(command)
      })
      expect(outcome).toEqual({
        accepted: false,
        error: 'Wait for pending work and messages to finish before using this command.'
      })
    }
    expect(commandCalls()).toHaveLength(0)
  })

  const compactCard = (held: boolean) => ({
    ...draft('compact-1'),
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: '/compact' }],
      command: { name: 'compact' as const }
    },
    ...(held ? { paused: true as const, pausedReason: 'send_failed' as const } : {})
  })

  it('a send behind a waiting command card queues, even with follow-ups off', () => {
    queuedMessages = [compactCard(false)]
    render(false)
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({
      capability: 'supported',
      enabled: true
    })
  })

  it('a send-failed command card, which the queue skips, does not force a send to queue', () => {
    queuedMessages = [compactCard(true)]
    render(false)
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({
      capability: 'supported',
      enabled: false
    })
  })
})

describe('a /compact against a host that queues messages but not commands', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
    ])
  })

  it('mid-turn, is held back here as today, and idle goes out without `delivery`', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('compact')
    })
    expect(commandCalls()).toHaveLength(0)
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    const idle = render()
    await act(async () => {
      await idle.result.current.runConversationCommand('compact')
    })
    expect(ConversationCommandParams.parse(commandCalls()[0])).not.toHaveProperty('delivery')
  })
})

describe('a /compact against a host that holds commands but has its queue dark', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
    ])
  })

  it("is exactly today's: held back mid-turn, and idle goes out without `delivery`", async () => {
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: "The agent is still working. Run /compact when it's done.",
      refusedWhile: 'working'
    })
    expect(commandCalls()).toHaveLength(0)
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    const idle = render()
    await act(async () => {
      await idle.result.current.runConversationCommand('compact')
    })
    expect(ConversationCommandParams.parse(commandCalls()[0])).not.toHaveProperty('delivery')
  })
})

describe('against a host without the capability', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
  })

  it('never asks for queue delivery, whatever the setting says', () => {
    render()
    expect(mocks.sendArgs.at(-1)?.queue?.capability).toBe('unsupported')
  })

  it("Stop stays exactly today's conversation Stop — no withdrawQueued key at all", async () => {
    const { result } = render()
    await act(async () => {
      await result.current.stop()
    })
    const [params] = cancels()
    expect(params).toBeDefined()
    expect(params).not.toHaveProperty('withdrawQueued')
  })

  it("/clear stays exactly today's command — no withdrawQueued key", async () => {
    items = []
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.conversationCommand'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { command: 'clear', state: 'completed' }
          }
        : null
    )
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    const clearCall = mocks.call.mock.calls.find(
      ([, method]) => method === 'agentSession.conversationCommand'
    )
    const parsed = ConversationCommandParams.parse(clearCall?.[2])
    expect('withdrawQueued' in parsed).toBe(false)
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: parsed.command }
      })
    )
  })

  it('steering the newest card is inert', () => {
    queuedMessages = [draft('draft-1')]
    const { result } = render()
    expect(result.current.queuedMessages.steerNewest()).toBe(false)
    expect(
      mocks.call.mock.calls.filter(([, method]) =>
        String(method).startsWith('agentSession.queuedMessage')
      )
    ).toHaveLength(0)
  })
})
