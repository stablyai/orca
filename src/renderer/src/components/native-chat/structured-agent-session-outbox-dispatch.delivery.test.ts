// @vitest-environment happy-dom
// A composer's saved draft keeps a sent message until the host has it. "Has it" is the host's ok
// reply to the send (pending, accepted or queued), not the provider's acceptance; a refusal, a
// rejection or a send dropped unconfirmed keeps the draft copy, and a new id is followed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import type {
  AgentJournalDispatchState,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { refuseUnclassified } from '../../../../shared/agent-session-wire-refusals'

const reply = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: reply.call
}))

import { dispatchStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-dispatch'
import {
  appendStructuredAgentSessionOutboxMessage,
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  noteStructuredAgentSessionMessagesDelivered,
  whenStructuredAgentSessionHostHasMessages
} from './structured-agent-session-message-delivery'

const SESSION = 'session-delivery'

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalDispatchState,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...overrides
  }
}

function ok(value: AgentSessionSendResult): AgentSessionMutationResult<AgentSessionSendResult> {
  return { ok: true, replayed: false, fence: 1, cursor: { epoch: 'epoch', sequence: 1 }, value }
}

async function sendWithReply(
  answer: (
    entry: StructuredAgentSessionOutboxEntry
  ) => AgentSessionMutationResult<AgentSessionSendResult>,
  prepare: (entry: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry = (
    entry
  ) => entry
): Promise<() => boolean> {
  const appended = appendStructuredAgentSessionOutboxMessage(SESSION, 'hello')
  if (!appended) {
    throw new Error('outbox append failed')
  }
  const entry = prepare(appended)
  commitStructuredAgentSessionOutbox(SESSION, [entry])
  let settled = false
  void whenStructuredAgentSessionHostHasMessages(SESSION, [entry]).then(() => {
    settled = true
  })
  reply.call.mockResolvedValueOnce(answer(entry))
  const dispatch = dispatchStructuredAgentSessionOutboxEntry({
    next: entry,
    entries: getStructuredAgentSessionOutbox(SESSION),
    sessionId: SESSION,
    target: { kind: 'local' },
    fence: 1,
    dispatchGeneration: 0,
    dispatchGenerationRef: { current: 0 },
    inFlightIdRef: { current: null },
    setError: () => {},
    applyDisposition: (disposition) => {
      commitStructuredAgentSessionOutbox(SESSION, disposition.entries)
    },
    createOperationId: () => 'rotated-id'
  })
  await dispatch.promise
  await Promise.resolve()
  return () => settled
}

beforeEach(() => {
  localStorage.clear()
  commitStructuredAgentSessionOutbox(SESSION, [])
})

afterEach(() => {
  reply.call.mockReset()
})

describe("a sent message's saved draft", () => {
  it('is released by an accepted reply', async () => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        submission: submission(entry.clientMessageId, 'accepted')
      })
    )

    expect(hostHasIt()).toBe(true)
  })

  // Until the agent accepts it the host can still lose it: not handed over, it is rejected when
  // Orca quits or after a crash; handed over (a send mid-turn joins the running turn at once) but
  // not in the agent's history, a reopen settles it as never delivered.
  it.each([
    ['not handed over yet', { handoverRecorded: true }],
    ['handed over into the running turn', { handoverRecorded: true, handedOverAt: 5 }],
    ['from an older host', {}]
  ] as const)(
    'is kept for a pending reply %s, until the agent accepts it',
    async (_label, overrides) => {
      const hostHasIt = await sendWithReply((entry) =>
        ok({
          clientMessageId: entry.clientMessageId,
          submission: submission(entry.clientMessageId, 'pending', overrides)
        })
      )
      expect(hostHasIt()).toBe(false)

      const [entry] = getStructuredAgentSessionOutbox(SESSION)
      noteStructuredAgentSessionMessagesDelivered(SESSION, [entry.clientMessageId])
      await Promise.resolve()
      expect(hostHasIt()).toBe(true)
    }
  )

  it('is released by a queued reply', async () => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        queued: { messageId: entry.clientMessageId, position: 1, state: 'waiting' }
      })
    )

    expect(hostHasIt()).toBe(true)
  })

  it('is kept for a rejected message, which stays for Retry', async () => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        submission: submission(entry.clientMessageId, 'rejected', { reason: 'no' })
      })
    )

    expect(hostHasIt()).toBe(false)
  })

  it('follows a refusal that gave the message a new id, and is released once that one lands', async () => {
    const hostHasIt = await sendWithReply(() => ({
      ok: false,
      refusal: refuseUnclassified('agent_session_owner_restart_failed', 'restart failed')
    }))
    expect(getStructuredAgentSessionOutbox(SESSION).map((entry) => entry.clientMessageId)).toEqual([
      'rotated-id'
    ])
    expect(hostHasIt()).toBe(false)

    noteStructuredAgentSessionMessagesDelivered(SESSION, ['rotated-id'])
    await Promise.resolve()
    expect(hostHasIt()).toBe(true)
  })

  it('is kept for a send the host dropped with its delivery unconfirmed', async () => {
    const hostHasIt = await sendWithReply(
      (entry) =>
        ok({
          clientMessageId: entry.clientMessageId,
          submission: submission(entry.clientMessageId, 'unknown', { submittedAt: 7 })
        }),
      (entry) => ({ ...entry, state: 'unconfirmed', retryAfterUnknownSubmittedAt: 7 })
    )

    expect(getStructuredAgentSessionOutbox(SESSION)).toEqual([])
    expect(hostHasIt()).toBe(false)
  })
})
