import { expect, it } from 'vitest'
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
    items: [
      {
        itemId: id,
        revision: 1,
        sequence: 8,
        observedAt: 0,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hi' }] }
      }
    ],
    submissions: [
      {
        clientMessageId: 'send',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 0,
        resolvedAt: null
      }
    ]
  }
  const batch: AgentSessionSubscribeEvent = {
    type: 'batch',
    sessionId: 'chat',
    fence: 1,
    batch: { cursor, items: [], removedItemIds: [], submissions: [] }
  }
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    state = reduceStructuredAgentSession(state, { type: 'event', event })
  })
  coalescer.push({ ...batch, providerReceived: [8] })
  coalescer.push(batch)
  coalescer.flush()
  expect(state.providerReceived?.get(id)).toBe(8)
  expect(state.submissions[0]?.dispatchState).toBe('pending')
  expect(state.working).toBeUndefined()
  state = reduceStructuredAgentSession(state, { type: 'event', event: batch, opensSubscription: true })
  expect(state.providerReceived).toBeUndefined()
  coalescer.push({ ...batch, providerReceived: [8] })
  coalescer.clearProviderReceived()
  coalescer.flush()
  expect(state.providerReceived).toBeUndefined()
  coalescer.dispose()
})
