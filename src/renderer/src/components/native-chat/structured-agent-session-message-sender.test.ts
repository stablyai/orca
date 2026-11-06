import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mocks,
  SESSION,
  target,
  deferredCalls,
  submission,
  okSubmission,
  refusedSend,
  flush,
  send,
  sendCalls,
  phases
} from './structured-agent-session-message-sender.test-fixture'

import {
  STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal,
  stopStructuredAgentSessionSends
} from './structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  structuredAgentSessionSendOut,
  subscribeToStructuredAgentSessionPendingSends
} from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { runtimes } from './structured-agent-session-send-runtime'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

describe('structured agent session message sender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.call.mockReset()
    mocks.handBack.mockClear()
    mocks.compatible.mockReset()
    mocks.compatible.mockResolvedValue(undefined)
    noteStructuredAgentSessionFence(SESSION, 4)
  })
  afterEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.useRealTimers()
  })

  it('refuses a second send while one is out, and takes the next once it settles', async () => {
    const calls = deferredCalls()
    const a = send('a')
    expect(sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })).toBeNull()
    await flush()
    expect(phases()).toEqual(['a:sending'])
    expect(calls).toHaveLength(1)
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    expect(await a.outcome).toBe('recorded')
    send('b')
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(mocks.call.mock.calls[1][2]).toMatchObject({
      envelope: { sessionId: SESSION, expectedRuntimeFence: 4 },
      body: { blocks: [{ type: 'text', text: 'b' }] }
    })
  })

  it('gives back at once, as not sent, a send whose checks fail before its request goes out', async () => {
    mocks.compatible.mockRejectedValue(new Error('connection refused'))
    const a = send('a', { target: { kind: 'environment', environmentId: 'env-1' } })
    expect(await a.outcome).toBe('returned')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain('was not sent')
    expect(mocks.compatible).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(mocks.compatible).toHaveBeenCalledOnce()
    expect(sendCalls()).toBe(0)
  })

  it('keeps an open chat drawing a send until a read covers its acknowledgement', async () => {
    const stop = subscribeToStructuredAgentSessionPendingSends(SESSION, () => {})
    const calls = deferredCalls()
    const a = send('a')
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [], { epoch: 'e', sequence: 5 })
    expect(phases()).toEqual(['a:sending'])
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    expect(await a.outcome).toBe('recorded')
    // The reply beat the history: the bubble stays, without blocking the next send.
    expect(phases()).toEqual(['a:recorded'])
    expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [], { epoch: 'e', sequence: 0 })
    expect(phases()).toEqual(['a:recorded'])
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [], { epoch: 'other', sequence: 5 })
    expect(phases()).toEqual(['a:recorded'])
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [], { epoch: 'e', sequence: 5 })
    expect(phases()).toEqual([])
    stop()
  })

  // Expired paired-server attachments require removal/reattachment, so return the whole message even without a mounted view.
  it('gives back a message refused for an expired attachment, with its file and why', async () => {
    const uploadId = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
    const STORED = `/srv/agent-session-attachments/${uploadId}/shot.png`
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: 'not stored',
        details: {
          reason: 'attachmentExpired',
          expiredAttachments: [{ uploadId, name: 'shot.png' }]
        }
      }
    })
    const a = send('look at this', { attachments: [{ path: STORED, previewUri: STORED }] })
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledExactlyOnceWith(
      SESSION,
      a.clientMessageId,
      {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'look at this' },
          { type: 'image-ref', path: STORED }
        ]
      },
      undefined,
      new Set([uploadId])
    )
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBe(
      'shot.png expired. Your message was not sent. Remove it and attach it again.'
    )
    expect(sendCalls()).toBe(1)
  })

  it('settles from the journal before the reply, and ignores the late reply', async () => {
    const calls = deferredCalls()
    const a = send('a')
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [a.clientMessageId])
    expect(await a.outcome).toBe('recorded')
    send('b')
    await flush()
    calls[0].reject(new Error('timeout'))
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(calls).toHaveLength(2)
  })

  it('never probes a host-recorded unknown, and sends what follows it', async () => {
    const calls = deferredCalls()
    const a = send('/permissions', {
      attachments: [{ path: '/shot.png', previewUri: '/shot.png' }]
    })
    await flush()
    // The agent died with the message on its way: the host recorded it and can't tell.
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'unknown', { recovered: true })],
      []
    )
    expect(await a.outcome).toBe('recorded')
    send('b')
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(calls).toHaveLength(2)
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it('retains an ordinary bubble when its request threw, and never sends it again', async () => {
    mocks.call.mockRejectedValue(new Error('connection closed'))
    const a = send('a')
    expect(await a.outcome).toBe('unconfirmed')
    expect(phases()).toEqual(['a:unconfirmed'])
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS * 2)
    expect(sendCalls()).toBe(1)
  })

  // Re-pairing refusals occur locally before forwarding, proving nothing was sent.
  it.each([false, true])(
    'returns a local pre-forwarding refusal even after deadline (%s)',
    async (late) => {
      const calls = deferredCalls()
      const a = send('a')
      await flush()
      if (late) {
        await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
        expect(await a.outcome).toBe('unconfirmed')
        expect(mocks.handBack).not.toHaveBeenCalled()
      }
      calls[0].reject(
        new RuntimeRpcCallError({
          id: 'agentSession.send',
          ok: false,
          error: {
            code: 'runtime_environment_changed',
            message: 'Runtime environment pairing changed; refresh and try again'
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      )
      await flush()
      expect(await a.outcome).toBe(late ? 'unconfirmed' : 'returned')
      expect(mocks.handBack).toHaveBeenCalledOnce()
      expect(phases()).toEqual([])
      expect(getStructuredAgentSessionSendNotice(SESSION)).toContain('Your message was not sent.')
      expect(getStructuredAgentSessionSendNotice(SESSION)).not.toContain("couldn't confirm")
      expect(sendCalls()).toBe(1)
    }
  )

  it('frees the chat and answers the caller when putting the text back throws', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.handBack.mockImplementationOnce(() => {
      throw new Error('draft write failed')
    })
    mocks.call.mockResolvedValueOnce(refusedSend)
    const a = send('a')
    expect(await a.outcome).toBe('returned')
    expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
    expect(phases()).toEqual([])
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain("Couldn't save your message.")
    expect(report).toHaveBeenCalledTimes(1)
    report.mockRestore()
    deferredCalls()
    send('b')
    expect(phases()).toEqual(['b:sending'])
  })

  it('gives back a message that never went out by the deadline, without sending it', async () => {
    const hang = new Promise(() => {})
    // Reading the fence hangs (an unreachable host): nothing was ever sent.
    mocks.call.mockImplementation((_target, method: string) =>
      method === 'agentSession.history' ? hang : Promise.resolve(refusedSend)
    )
    const { resetStructuredAgentSessionSendsForTests: reset } =
      await import('./structured-agent-session-message-sender')
    reset()
    const a = send('a')
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(mocks.call.mock.calls.some((call) => call[1] === 'agentSession.send')).toBe(false)
  })

  it('gives back silently, and never sends, one a Stop finds still being readied', async () => {
    deferredCalls()
    mocks.compatible.mockImplementationOnce(() => new Promise<void>(() => {}))
    const a = send('a', { target: { kind: 'environment', environmentId: 'env-1' } })
    await flush()
    stopStructuredAgentSessionSends(SESSION)
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(sendCalls()).toBe(0)
  })

  it('lets a send on its way when Stop was pressed settle from its answer, never a resend', async () => {
    const calls = deferredCalls()
    const a = send('a')
    await flush()
    stopStructuredAgentSessionSends(SESSION)
    expect(structuredAgentSessionSendOut(SESSION)).toBe(true)
    calls[0].reject(new Error('timeout'))
    expect(await a.outcome).toBe('unconfirmed')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS * 2)
    expect(sendCalls()).toBe(1)
  })

  it('settles a send on its way at a Stop from its answer: recorded, or the host held it as a card', async () => {
    const calls = deferredCalls()
    const a = send('a')
    await flush()
    stopStructuredAgentSessionSends(SESSION)
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'accepted')],
      []
    )
    expect(await a.outcome).toBe('recorded')
    const b = send('b', {
      delivery: 'queue-if-active'
    })
    await flush()
    stopStructuredAgentSessionSends(SESSION)
    calls[1].resolve({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: b.clientMessageId,
        queued: { messageId: b.clientMessageId, position: 0, state: 'waiting' }
      }
    })
    expect(await b.outcome).toBe('recorded')
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it("lets a send kept as a card be the card's, from its reply or the journal", async () => {
    const kept = (id: string) =>
      submission(id, 'rejected', {
        rejection: { kind: 'hostRestarted' },
        keptAsQueuedMessageId: id
      })
    mocks.call.mockImplementation(async (_target, _method, params) => ({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: params.envelope.clientOperationId,
        submission: kept(params.envelope.clientOperationId)
      }
    }))
    const a = send('a')
    expect(await a.outcome).toBe('recorded')
    const calls = deferredCalls()
    const b = send('b')
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [kept(b.clientMessageId)], [])
    expect(await b.outcome).toBe('recorded')
    calls[0].reject(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(sendCalls()).toBe(2)
  })

  it('leaves in the chat a send whose own reply says a Stop withdrew it', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: params.envelope.clientOperationId,
        submission: submission(params.envelope.clientOperationId, 'rejected', {
          rejection: { kind: 'cancelled' }
        })
      }
    }))
    const a = send('a')
    expect(await a.outcome).toBe('recorded')
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
  })

  it('leaves a send to its own answer while the journal has no row for it', async () => {
    const calls = deferredCalls()
    const a = send('a')
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [submission('other', 'accepted')], [])
    expect(phases()).toEqual(['a:sending'])
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    expect(await a.outcome).toBe('recorded')
  })

  it('reads a pending row in the journal as the host holding it, drawn from then on by that row', async () => {
    deferredCalls()
    const a = send('a')
    await flush()
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'pending')],
      []
    )
    expect(await a.outcome).toBe('recorded')
    send('b')
    await flush()
    expect(phases()).toEqual(['b:sending'])
  })

  // A card owns the text from the moment the host holds it, whatever happens to the card after.
  it.each([
    ['refused', { rejection: { kind: 'notSignedIn' } }],
    ['withdrawn by a Stop', { rejection: { kind: 'cancelled' } }]
  ] as const)(
    'never hands back a queue send whose card was handed off and then %s',
    async (_how, fate) => {
      const calls = deferredCalls()
      const a = send('a', { delivery: 'queue-if-active' })
      await flush()
      settleStructuredAgentSessionSendsFromJournal(
        SESSION,
        [submission('hand-off', 'rejected', { queuedMessageId: a.clientMessageId, ...fate })],
        []
      )
      expect(await a.outcome).toBe('recorded')
      calls[0].reject(new Error('timeout'))
      await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
      expect(mocks.handBack).not.toHaveBeenCalled()
      expect(sendCalls()).toBe(1)
    }
  )
})

// Unknown sends must release the chat at their deadline rather than waiting indefinitely for a decision.
describe('a send whose fate is unknown never freezes the chat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.call.mockReset()
    mocks.handBack.mockClear()
    mocks.compatible.mockReset()
    mocks.compatible.mockResolvedValue(undefined)
    noteStructuredAgentSessionFence(SESSION, 4)
  })
  afterEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.useRealTimers()
  })

  it.each(['journal', 'reply'] as const)(
    'ends its operation once and reconciles a late exact %s',
    async (from) => {
      const calls = deferredCalls()
      const a = send('complete original $review', {
        attachments: [
          { path: '/remote/a.png', previewUri: 'blob:original', connectionId: 'ssh-1' }
        ],
        options: { model: 'gpt-5.6-sol', effort: 'high' },
        skills: [{ name: 'review', path: '/skills/review/SKILL.md' }]
      })
      const completed = vi.fn()
      void a.outcome.then(completed)
      await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
      expect(await a.outcome).toBe('unconfirmed')
      expect(runtimes.has(a.clientMessageId)).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
      const pending = getStructuredAgentSessionPendingSends(SESSION)
      expect(pending[0]).toMatchObject({
        phase: 'unconfirmed',
        options: { effort: 'high' },
        previewUris: ['blob:original'],
        imageConnectionIds: ['ssh-1']
      })
      const messages = projectStructuredAgentSessionMessages([], pending, [])
      expect(messages[0]?.deliveryState).toBe('unknown')
      expect(pending[0].body.skills).toEqual([{ name: 'review', path: '/skills/review/SKILL.md' }])
      expect(pending[0].body.blocks).toContainEqual({
        type: 'text',
        text: 'complete original $review'
      })
      expect(
        structuredAgentSessionDeliveryNotices({
          pending,
          submissions: [],
          agentName: 'Codex',
          startFailures: []
        }).size
      ).toBe(0)
      await getStructuredAgentSessionReadOwner(SESSION, target).admit(
        'close-or-rewind',
        () => true,
        (attempt) => expect(attempt.busy()).toBe(false)
      )
      const b = send('newer input')
      await flush()
      settleStructuredAgentSessionSendsFromJournal(
        SESSION,
        [
          submission('other', 'accepted'),
          submission(a.clientMessageId, 'unknown', { reason: 'durable_send_submission_missing' })
        ],
        []
      )
      expect(phases()).toEqual(['complete original $review:unconfirmed', 'newer input:sending'])
      if (from === 'journal') {
        settleStructuredAgentSessionSendsFromJournal(
          SESSION,
          [submission(a.clientMessageId, 'accepted')],
          []
        )
        calls[0].reject(new Error('late transport failure'))
      } else {
        calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
      }
      await flush()
      expect(phases()).toEqual(['newer input:sending'])
      expect(completed).toHaveBeenCalledExactlyOnceWith('unconfirmed')
      expect(mocks.handBack).not.toHaveBeenCalled()
      expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
      calls[1].resolve(okSubmission(b.clientMessageId, 'accepted'))
      expect(await b.outcome).toBe('recorded')
      expect(sendCalls()).toBe(2)
    }
  )

  it('sends the next at once when the host can neither confirm nor deny the one ahead', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'unknown',
        details: { reason: 'outcomeUnknown' }
      }
    })
    const a = send('a')
    expect(await a.outcome).toBe('unconfirmed')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
    const calls = deferredCalls()
    send('b')
    await flush()
    expect(phases()).toEqual(['a:unconfirmed', 'b:sending'])
    expect(calls).toHaveLength(1)
  })
})
