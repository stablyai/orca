import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { agentJournalSubmissionKey } from '../../journal/agent-session-journal-item-key'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

it('applies a coalesced receipt at the same cursor and clears it on resubscribe', () => {
  const id = agentJournalSubmissionKey('send')
  const cursor = { epoch: 'epoch', sequence: 9 }
  let state: StructuredAgentSessionState = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    status: 'ready',
    epoch: cursor.epoch,
    fence: 1,
    cursor,
    items: [],
    submissions: []
  }
  const items: StructuredAgentSessionState['items'] = [
    {
      itemId: id,
      revision: 1,
      sequence: 8,
      observedAt: 0,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hi' }] }
    }
  ]
  const submissions: StructuredAgentSessionState['submissions'] = [
    {
      clientMessageId: 'send',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 0,
      handedOverAt: 0,
      resolvedAt: null
    }
  ]
  const batch: AgentSessionSubscribeEvent = {
    type: 'batch',
    sessionId: 'chat',
    fence: 1,
    batch: { cursor, items: [], removedItemIds: [], submissions: [] }
  }
  state = reduceStructuredAgentSession(state, {
    type: 'event',
    receiptProvider: 'claude',
    event: { ...batch, batch: { ...batch.batch, items, submissions } }
  })
  const coalescer = createStructuredAgentSessionEventCoalescer(
    (event) => {
      state = reduceStructuredAgentSession(state, {
        type: 'event',
        event,
        receiptProvider: 'claude'
      })
    },
    { receiptProvider: 'claude' }
  )
  coalescer.push(batch)
  coalescer.push({ ...batch, providerReceived: [8] })
  coalescer.push(batch)
  coalescer.flush()
  expect(state.providerReceived?.get(id)).toBe(8)
  expect(state.submissions[0]?.dispatchState).toBe('pending')
  expect(state.working).toBeUndefined()
  state = reduceStructuredAgentSession(state, {
    type: 'event',
    event: batch,
    receiptProvider: 'claude',
    opensSubscription: true
  })
  expect(state.providerReceived).toBeUndefined()
  coalescer.push({ ...batch, providerReceived: [8] })
  coalescer.clearProviderReceived()
  coalescer.flush()
  expect(state.providerReceived).toBeUndefined()
  coalescer.dispose()
})

it.each([
  ['claude', 64],
  ['codex', 256]
] as const)(
  'holds %s receipts within the provider cap and prunes an exact settlement without drawing text',
  (receiptProvider, limit) => {
    vi.useFakeTimers()
    try {
      const cursor = { epoch: 'epoch', sequence: limit + 10 }
      const batch = {
        type: 'batch' as const,
        sessionId: 'chat',
        fence: 1,
        batch: { cursor, items: [], removedItemIds: [], submissions: [] }
      }
      let show = () => {}
      const draw = vi.fn()
      const emit = vi.fn()
      const coalescer = createStructuredAgentSessionEventCoalescer(emit, {
        receiptProvider,
        pendingReceiptSequence: (id) => (id === agentJournalSubmissionKey('first') ? 1 : undefined),
        visibility: {
          hidden: () => true,
          sendsShownTail: () => true,
          heldDrawn: draw,
          subscribeShown: (shown) => {
            show = shown
            return () => {}
          }
        }
      })
      coalescer.push({ ...batch, providerReceived: [1] })
      expect(vi.getTimerCount()).toBe(0)
      expect(emit).toHaveBeenCalledTimes(1)
      emit.mockClear()
      coalescer.push({
        ...batch,
        batch: {
          ...batch.batch,
          items: [
            {
              itemId: 'text',
              revision: 1,
              sequence: 1,
              observedAt: 0,
              body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'held' }] }
            }
          ]
        }
      })
      coalescer.push({
        ...batch,
        providerReceived: Array.from({ length: limit + 1 }, (_, index) => index + 1)
      })
      coalescer.push({
        ...batch,
        batch: {
          ...batch.batch,
          submissions: [
            {
              clientMessageId: 'first',
              fence: 1,
              payloadFingerprint: 'first',
              dispatchState: 'accepted',
              providerItemId: null,
              reason: null,
              submittedAt: 0,
              resolvedAt: 1
            }
          ]
        }
      })
      show()
      coalescer.push({ ...batch, providerReceived: [limit + 2] })
      expect(emit).not.toHaveBeenCalled()
      expect(draw).not.toHaveBeenCalled()
      coalescer.push(batch)
      expect(draw).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit.mock.calls[0]?.[0].providerReceived).toEqual([
        ...Array.from({ length: limit - 1 }, (_, index) => index + 2),
        limit + 2
      ])
      coalescer.dispose()
    } finally {
      vi.useRealTimers()
    }
  }
)

it.each([
  ['claude', 64],
  ['codex', 256]
] as const)('keeps the applied %s map within its own cap', (receiptProvider, limit) => {
  const indexed = Array.from(
    { length: limit + 1 },
    (_, index) => [index + 1, agentJournalSubmissionKey(String(index + 1))] as const
  )
  const cursor = { epoch: 'epoch', sequence: limit + 1 }
  const state = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: cursor.epoch,
    cursor,
    fence: 1,
    status: 'ready' as const,
    pendingProviderAttempts: {
      bySequence: new Map(indexed),
      byItem: new Map(indexed.map(([sequence, id]) => [id, sequence]))
    }
  }
  const batch = {
    type: 'batch' as const,
    sessionId: 'chat',
    fence: 1,
    batch: { cursor, items: [], submissions: [], removedItemIds: [] }
  }
  const full = reduceStructuredAgentSession(state, {
    type: 'event',
    receiptProvider,
    event: { ...batch, providerReceived: indexed.slice(0, limit).map(([sequence]) => sequence) }
  })
  expect(full.providerReceived?.size).toBe(limit)
  expect(
    reduceStructuredAgentSession(full, {
      type: 'event',
      receiptProvider,
      event: { ...batch, providerReceived: [limit + 1] }
    })
  ).toBe(full)
})
