import { expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '../../agent-session-wire'
import type { AgentJournalSubmission } from '../../journal/agent-session-journal-types'
import { materializeStructuredAgentSubmissions } from '../structured-agent-session-submissions'
import { structuredAgentSessionSendingItemIds } from '../structured-agent-session-sending'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction
} from './structured-agent-session-reducer'
type StoredCopy = { journal: { submissions: AgentJournalSubmission[] } }
const { storedStructuredAgentSessionState, storedStructuredCopy } = await vi.importActual<{
  storedStructuredCopy: (
    state: typeof EMPTY_STRUCTURED_AGENT_SESSION,
    savedAt: number
  ) => StoredCopy
  storedStructuredAgentSessionState: (copy: StoredCopy) => typeof EMPTY_STRUCTURED_AGENT_SESSION
}>(
  '../../../../../mobile/src/session/native-chat/transcript/persistence/mobile-native-chat-transcript-writer'
)

const cursor = (sequence: number, epoch = 'epoch') => ({ epoch, sequence })
const A: AgentJournalSubmission = {
  clientMessageId: 'a',
  fence: 2,
  submittedAt: 100,
  payloadFingerprint: 'a-prompt',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  resolvedAt: null,
  handoverRecorded: true,
  handedOverAt: 110
}
const B = { ...A, clientMessageId: 'b', submittedAt: 200, handedOverAt: 210 }
const receipt = { ...A, writtenAt: 120 }
const redispatch = { ...A, fence: 3, handedOverAt: 300 }

function page(
  at: number,
  submissions: AgentJournalSubmission[],
  epoch = 'epoch'
): AgentSessionHistoryPage {
  return {
    sessionId: 'chat',
    epoch,
    direction: 'before',
    items: [],
    removedItemIds: [],
    submissions,
    window: { oldest: null, newest: null, nextCursor: cursor(0, epoch) },
    liveCursor: cursor(at, epoch),
    hasOlder: true,
    hasNewer: false
  }
}

function live(at: number, ...submissions: AgentJournalSubmission[]): StructuredAgentSessionAction {
  return {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 'chat',
      batch: { cursor: cursor(at), submissions, items: [], removedItemIds: [] }
    }
  }
}

function older(at: number, ...submissions: AgentJournalSubmission[]): StructuredAgentSessionAction {
  return { type: 'older-page', requestedCursor: cursor(10), page: page(at, submissions) }
}

// The former reducer's stamped-submission projection for this itemless replay. The last 256
// records survive its merge, and a live stamp-only restatement keeps the prior sort order.
function reduceStampedSubmissions(
  previous: AgentJournalSubmission[],
  action: StructuredAgentSessionAction
): AgentJournalSubmission[] {
  if (action.type === 'history-page') {
    return action.page.submissions
  }
  if (
    action.type === 'event' &&
    (action.event.type === 'snapshot' || action.event.type === 'reset')
  ) {
    return action.event.page.submissions
  }
  const event = action.type === 'event' && action.event.type === 'batch' ? action.event : null
  const incoming = event
    ? event.batch.submissions
    : action.type === 'older-page'
      ? action.page.submissions
      : []
  const byId = new Map(previous.map((submission) => [submission.clientMessageId, submission]))
  let reuseRetention = event !== null
  for (const row of incoming) {
    const prior = byId.get(row.clientMessageId)
    reuseRetention &&=
      !!prior &&
      (prior === row ||
        (prior.writtenAt !== row.writtenAt &&
          JSON.stringify({ ...prior, writtenAt: undefined }) ===
            JSON.stringify({ ...row, writtenAt: undefined })))
    byId.set(row.clientMessageId, row)
  }
  const records = [...byId.values()]
  return reuseRetention
    ? records
    : records.sort((a, b) => a.submittedAt - b.submittedAt).slice(-256)
}

it('matches the stamped reducer through snapshot, batches, paging, re-dispatch and reset', () => {
  const actions: StructuredAgentSessionAction[] = [
    { type: 'history-page', page: page(0, []) },
    {
      type: 'event',
      event: { type: 'snapshot', sessionId: 'chat', fence: 2, page: page(10, [A]) }
    },
    live(11, B),
    older(11, { ...A, providerItemId: 'opener-alias' }),
    live(12, { ...receipt, providerItemId: 'opener-alias' }),
    live(13, { ...B, writtenAt: 221 }),
    live(14, redispatch),
    {
      type: 'event',
      event: {
        type: 'reset',
        reset: 'epoch_changed',
        sessionId: 'chat',
        fence: 4,
        page: page(1, [receipt], 'new')
      }
    }
  ]
  let previous: AgentJournalSubmission[] = []
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  for (const action of actions) {
    previous = reduceStampedSubmissions(previous, action)
    state = reduceStructuredAgentSession(state, action, 500)
    expect(materializeStructuredAgentSubmissions(state)).toStrictEqual(previous)
    expect(state.submissions.every((record) => !('writtenAt' in record))).toBe(true)
  }
  const stored = storedStructuredCopy(state, 600)
  expect(stored.journal.submissions).toStrictEqual(previous)
  const restored = storedStructuredAgentSessionState(stored)
  expect(restored.writtenAtById.get('a')).toBe(120)
  expect(restored.submissions).toStrictEqual(state.submissions)
  expect(materializeStructuredAgentSubmissions(restored)).toStrictEqual(previous)
})

it('keeps the current receipt through stale paging and removes it on a new attempt', () => {
  const apply = (
    state: typeof EMPTY_STRUCTURED_AGENT_SESSION,
    action: StructuredAgentSessionAction
  ) => reduceStructuredAgentSession(state, action, 500)
  const initial = apply(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'history-page',
    page: page(10, [A, B])
  })
  const stamped = apply(initial, live(11, receipt))
  const stale = apply(stamped, older(10, A))
  expect(materializeStructuredAgentSubmissions(stale)).toStrictEqual([receipt, B])
  expect(structuredAgentSessionSendingItemIds([], stale.submissions, stale.writtenAtById)).toEqual(
    new Set(['orca:b'])
  )
  const restarted = apply(stale, live(12, redispatch))
  const firstAttempt = apply(restarted, older(11, receipt))
  expect(materializeStructuredAgentSubmissions(firstAttempt)).toStrictEqual([redispatch, B])
  const ahead = apply(stamped, older(13, redispatch))
  expect(materializeStructuredAgentSubmissions(apply(ahead, live(12, receipt)))).toStrictEqual([
    redispatch,
    B
  ])
  expect(materializeStructuredAgentSubmissions(apply(ahead, older(12, receipt)))).toStrictEqual([
    redispatch,
    B
  ])
  expect(stamped.writtenAtById.get('a')).toBe(120)
  expect(firstAttempt.writtenAtById.get('a')).toBeUndefined()
  expect(
    structuredAgentSessionSendingItemIds([], firstAttempt.submissions, firstAttempt.writtenAtById)
  ).toEqual(new Set(['orca:a', 'orca:b']))
})
