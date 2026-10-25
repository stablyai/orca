import { expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  reserveStructuredAgentSessionSend,
  type sendStructuredAgentSessionMessage
} from './structured-agent-session-message-sender'
import {
  structuredAgentSessionSendOut,
  subscribeToStructuredAgentSessionPendingSends
} from './structured-agent-session-pending-sends'

/** The create-owned schedules run inside the sender suite's isolated clock and transport. */
export function registerCreateOwnedSenderContracts({
  SESSION,
  target,
  mocks,
  phases,
  sendCalls,
  deferredCalls,
  send,
  flush,
  okSubmission,
  submission
}: {
  SESSION: string
  target: { readonly kind: 'local' }
  mocks: { handBack: Mock<() => boolean> }
  phases: () => string[]
  sendCalls: () => number
  deferredCalls: () => { resolve: (value: unknown) => void; reject: (error: unknown) => void }[]
  send: (text: string) => NonNullable<ReturnType<typeof sendStructuredAgentSessionMessage>>
  flush: () => Promise<void>
  okSubmission: (clientMessageId: string, dispatchState: 'pending' | 'accepted') => unknown
  submission: (
    clientMessageId: string,
    dispatchState: AgentJournalSubmission['dispatchState']
  ) => AgentJournalSubmission
}): void {
  it('waits through slow creation, then starts one normal budget only at actual target activation', async () => {
    const slot = reserveStructuredAgentSessionSend({ sessionId: SESSION, text: 'founding A' })
    if (!slot) {
      throw new Error('expected a reservation')
    }
    slot.legacy()
    await vi.advanceTimersByTimeAsync(35_000)
    const create = slot.create(target, { deferUntilTarget: true })
    if (!create) {
      throw new Error('slow creation must retain its reservation')
    }
    const outcome = vi.fn()
    void create.outcome.then(outcome)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(outcome).not.toHaveBeenCalled()
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(phases()).toEqual(['founding A:sending'])
    expect(sendCalls()).toBe(0)

    create.activate()
    await vi.advanceTimersByTimeAsync(15_000)
    create.activate()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(outcome).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await create.outcome).toBe('unconfirmed')
    expect(await slot.outcome).toBe('unconfirmed')
    expect(mocks.handBack).toHaveBeenCalledOnce()
    expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
    expect(phases()).toEqual([])
    create.activate()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(mocks.handBack).toHaveBeenCalledOnce()
    expect(sendCalls()).toBe(0)

    const calls = deferredCalls()
    const b = send('ordinary B')
    await flush()
    expect(sendCalls()).toBe(1)
    calls[0].resolve(okSubmission(b.clientMessageId, 'accepted'))
    expect(await b.outcome).toBe('recorded')
  })

  it('fully retires exact scalar founding proof even while watched, including a retained reply echo', async () => {
    const stop = subscribeToStructuredAgentSessionPendingSends(SESSION, () => {})
    try {
      const id = '1790000000123-b4a6aab1c63a7cd37871a6d77772d9e2'
      const slot = reserveStructuredAgentSessionSend({
        sessionId: SESSION,
        text: 'A',
        clientMessageId: id
      })
      if (!slot) {
        throw new Error('expected a founding reservation')
      }
      const create = slot.create(target, { deferUntilTarget: true })
      if (!create) {
        throw new Error('expected deferred create')
      }
      expect(create.message.clientMessageId).toBe(id)
      await vi.advanceTimersByTimeAsync(35_000)
      create.settle({ kind: 'recorded-proof', sessionId: 'another-session', clientMessageId: id })
      create.settle({
        kind: 'recorded-proof',
        sessionId: SESSION,
        clientMessageId: 'another-message'
      })
      expect(structuredAgentSessionSendOut(SESSION)).toBe(true)
      create.settle({ kind: 'recorded-proof', sessionId: SESSION, clientMessageId: id })
      expect(await create.outcome).toBe('recorded')
      expect(await slot.outcome).toBe('recorded')
      expect(phases()).toEqual([])

      const next = reserveStructuredAgentSessionSend({ sessionId: SESSION, text: 'B' })?.create(
        target
      )
      if (!next) {
        throw new Error('scalar proof must release the exact slot')
      }
      next.settle({ kind: 'recorded', submission: submission(next.clientMessageId, 'accepted') })
      expect(await next.outcome).toBe('recorded')
      expect(phases()).toEqual(['B:recorded'])
      next.settle({
        kind: 'recorded-proof',
        sessionId: SESSION,
        clientMessageId: next.clientMessageId
      })
      expect(phases()).toEqual([])
      create.activate()
      next.activate()
      await vi.advanceTimersByTimeAsync(35_000)
      expect(mocks.handBack).not.toHaveBeenCalled()
      expect(sendCalls()).toBe(0)
    } finally {
      stop()
    }
  })
}
