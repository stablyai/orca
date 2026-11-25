import { expect, it } from 'vitest'
import type { AgentSessionHistoryPage } from '../agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './live-read/structured-agent-session-reducer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../requests/agent-session-queued-message-wire'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { structuredAgentSessionSendingItemIds } from './structured-agent-session-sending'
import { splitStructuredAgentSubmissions } from './structured-agent-session-submissions'
import {
  reconcileQueuedSteerIntents,
  steeringQueuedMessageEchoes
} from './structured-agent-session-sending-queued-cards'

const draft: AgentSessionQueuedMessage = {
  messageId: 'draft',
  position: 1,
  state: 'waiting',
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'follow up' }] }
}
const sibling = { ...draft, messageId: 'sibling', position: 2 }
const attempt = {
  clientMessageId: 'attempt',
  queuedMessageId: draft.messageId,
  handoverRecorded: true,
  dispatchState: 'pending',
  submittedAt: 10,
  resolvedAt: null,
  providerItemId: null,
  payloadFingerprint: 'follow up',
  reason: null,
  fence: 1
} satisfies AgentJournalSubmission
const session = { agentWorking: true, queuePaused: false }
const steer = { ...draft, steers: true as const }

it.each(['listed', 'removed', 'direct'])(
  'keeps one Sending member from Steer to receipt (%s)',
  (path) => {
    let intents: ReadonlyMap<string, string> = new Map()
    const check = (
      queue: AgentSessionQueuedMessage[],
      record?: AgentJournalSubmission,
      receipt?: number
    ) => {
      const { submissions, writtenAtById } = splitStructuredAgentSubmissions(
        record ? [{ ...record, writtenAt: receipt }] : []
      )
      const cards = [...queue, sibling]
      intents = reconcileQueuedSteerIntents(intents, cards, submissions, session)
      const optimistic = steeringQueuedMessageEchoes(cards, submissions, [], {
        ...session,
        steerIntents: intents
      })
      return [...structuredAgentSessionSendingItemIds(optimistic, submissions, writtenAtById)]
    }
    expect(check([draft])).toEqual([])
    intents = new Map([[draft.messageId, attempt.clientMessageId]])
    expect(check([draft])).toEqual(['orca:draft'])
    if (path !== 'direct') {
      expect(check([steer])).toEqual(['orca:draft'])
    }
    const queue = path === 'listed' ? [steer] : []
    expect(check(queue, attempt)).toEqual(['orca:attempt'])
    const handedOver = { ...attempt, handedOverAt: 20 }
    expect(check(queue, handedOver)).toEqual(['orca:attempt'])
    expect(check(queue, handedOver, 21)).toEqual([])
    expect(intents.size).toBe(0)

    const cursor = (sequence: number) => ({ epoch: 'epoch', sequence })
    const page = (sequence: number, record: AgentJournalSubmission): AgentSessionHistoryPage => ({
      sessionId: 'chat',
      epoch: 'epoch',
      direction: 'before',
      submissions: [record],
      items: [],
      removedItemIds: [],
      window: { oldest: null, newest: null, nextCursor: cursor(0) },
      liveCursor: cursor(sequence),
      hasOlder: true,
      hasNewer: false
    })
    const fresh = reduceStructuredAgentSession(
      EMPTY_STRUCTURED_AGENT_SESSION,
      {
        type: 'history-page',
        page: page(10, { ...attempt, fence: 2, handedOverAt: 30 })
      },
      40
    )
    const replayed = reduceStructuredAgentSession(
      fresh,
      {
        type: 'older-page',
        requestedCursor: cursor(10),
        page: page(9, { ...handedOver, writtenAt: 21 })
      },
      40
    )
    expect([
      ...structuredAgentSessionSendingItemIds([], replayed.submissions, replayed.writtenAtById)
    ]).toEqual(['orca:attempt'])
  }
)

it('agrees with the transcript about which pending submissions are held', () => {
  const item: AgentJournalRenderItem = {
    itemId: 'orca:attempt',
    sequence: 1,
    revision: 0,
    observedAt: 1,
    body: draft.body
  }
  for (const dispatchState of ['pending', 'accepted', 'rejected', 'unknown'] as const) {
    for (const queuedMessageId of [undefined, 'draft']) {
      for (const handedOverAt of [undefined, 20]) {
        for (const handoverRecorded of [undefined, true] as const) {
          const record = {
            ...attempt,
            dispatchState,
            queuedMessageId,
            handedOverAt,
            handoverRecorded
          }
          const [row] = projectStructuredAgentSessionMessages([item], [], [record])
          const sending = structuredAgentSessionSendingItemIds([], [record], new Map())
          expect(sending.has(item.itemId), JSON.stringify(record)).toBe(
            !!row && !row.queued && dispatchState === 'pending'
          )
        }
      }
    }
  }
})
