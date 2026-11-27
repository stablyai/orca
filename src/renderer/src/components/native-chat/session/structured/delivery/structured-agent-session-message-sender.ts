import { settleStructuredLaunchFirstMessageFromJournal } from '@/lib/agent-session/launch/structured-agent-session-launch-input'
import type { AgentJournalCursor } from '../../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import { structuredAgentSessionSendBody } from '../../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import {
  structuredAgentSessionReadCoversSend,
  structuredAgentSessionSettledSends
} from '../../../../../../../shared/agent-session/requests/structured-agent-session-send-settlement'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { dispatchStructuredAgentSessionSend } from './structured-agent-session-send-dispatch'
import { resetStructuredAgentSessionReadOwnersForTests } from '../read/structured-agent-session-read-owner-registry'
import {
  forgetStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from './structured-agent-session-send-attempt'
import {
  takeStructuredAgentSessionSendSlot,
  type StructuredAgentSessionSendInput
} from './structured-agent-session-send-slot'
import {
  clearStructuredAgentSessionPendingSends,
  findStructuredAgentSessionPendingSend,
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  structuredAgentSessionsWithPendingSends,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'
import {
  beginSend,
  finish,
  forgetStructuredAgentSessionSendRecorded,
  grantStructuredAgentSessionSendCustody,
  handBack,
  handBackRefused,
  observeStructuredAgentSessionHandBack,
  retainUnconfirmed,
  retireStructuredAgentSessionSend,
  revokeStructuredAgentSessionSendCustody,
  runtimes,
  settleRecorded,
  structuredAgentSessionSendRecorded,
  STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS,
  type StructuredAgentSessionHandBackCustody,
  type StructuredAgentSessionSendOutcome,
  type StructuredAgentSessionSent
} from './structured-agent-session-send-runtime'
// Bound live sends independently of ordinary in-memory input; only exact host facts reconcile it.
import type { StructuredAgentSessionReservedSend } from './structured-agent-session-reserved-send'
export type {
  StructuredAgentSessionCreateSend,
  StructuredAgentSessionReservedSend
} from './structured-agent-session-reserved-send'

const reservations = new Map<string, { stop: () => void; drop: () => void }>()

/** Reserve one chat send; resolve as recorded, returned, unconfirmed or dropped, and return null while another is outstanding. */
export function sendStructuredAgentSessionMessage(
  input: StructuredAgentSessionSendInput & { target: RuntimeClientTarget }
): StructuredAgentSessionSent | null {
  if (input.prepareAttachments) {
    const reservation = reserveStructuredAgentSessionSend(input)
    if (!reservation) {
      return null
    }
    input.onCreated?.(reservation.clientMessageId)
    reservation.legacy()
    void input.prepareAttachments(input, reservation.active).then(
      ({ custodyLost, ...prepared }) => {
        if (reservation.prepare({ ...prepared, skills: input.skills }, custodyLost)) {
          reservation.send(input.target)
        }
      },
      (error) => reservation.fail(error instanceof Error ? error.message : String(error))
    )
    return reservation
  }
  const entry = takeStructuredAgentSessionSendSlot(input)
  if (!entry) {
    return null
  }
  if (input.custodyLost) {
    grantStructuredAgentSessionSendCustody(entry.clientMessageId, input.custodyLost)
  }
  input.onCreated?.(entry.clientMessageId)
  return dispatchStructuredAgentSessionSend(entry, input.target)
}

/** Reserve the launch prompt at click time so later typing cannot overtake it before chat creation. */
export function reserveStructuredAgentSessionSend(
  input: StructuredAgentSessionSendInput
): StructuredAgentSessionReservedSend | null {
  const entry = takeStructuredAgentSessionSendSlot(input)
  if (!entry) {
    return null
  }
  // Once sent, the entry is the send's: what it keeps after settling is not the reservation's.
  let sent = false
  let settleReservation = (_outcome: StructuredAgentSessionSendOutcome): void => {}
  // Made with the reservation, so whoever holds it hears of a recording however the send reports it.
  const recorded = structuredAgentSessionSendRecorded(entry.clientMessageId)
  // Heard before the outcome settles, so a reader of a `returned` outcome knows what came back.
  let handedBack: StructuredAgentSessionHandBackCustody | undefined
  const stopObserving = observeStructuredAgentSessionHandBack(entry.clientMessageId, (custody) => {
    handedBack = custody
  })
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    settleReservation = (outcome) => {
      stopObserving()
      revokeStructuredAgentSessionSendCustody(entry.clientMessageId)
      reservations.delete(entry.clientMessageId)
      if (outcome === 'returned' || outcome === 'dropped') {
        forgetStructuredAgentSessionSendRecorded(entry.clientMessageId)
      }
      resolve(outcome)
    }
  })
  const held = (): StructuredAgentSessionPendingSend | undefined =>
    sent ? undefined : findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  const deadline = setTimeout(() => {
    const current = held()
    if (current) {
      handBack(current, ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')])
      settleReservation('returned')
    }
  }, STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
  const release = (): void => {
    clearTimeout(deadline)
    if (held()) {
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, null)
      settleReservation('dropped')
    }
  }
  reservations.set(entry.clientMessageId, {
    stop: () => {
      const current = held()
      if (current) {
        clearTimeout(deadline)
        handBack(current, null)
        settleReservation('returned')
      }
    },
    drop: release
  })
  return {
    clientMessageId: entry.clientMessageId,
    fail: (notice) => {
      const current = held()
      if (current) {
        clearTimeout(deadline)
        if (!notice) {
          // Empty when another notice already says why (a file held in another chat's draft).
          publishStructuredAgentSessionSends(entry.sessionId, { notice: null })
        }
        // Why the hand-back words it: a hand-back that threw adds that the message wasn't saved.
        handBack(current, notice ? [{ text: notice }] : null)
        settleReservation('returned')
      }
    },
    outcome,
    recorded,
    active: () => held() !== undefined,
    legacy: () => clearTimeout(deadline),
    handedBack: () => handedBack,
    prepare: (input, custodyLost) => {
      const current = held()
      if (!current) {
        return false
      }
      if (custodyLost) {
        grantStructuredAgentSessionSendCustody(current.clientMessageId, custodyLost)
      }
      updateStructuredAgentSessionPendingSend(current.sessionId, current.clientMessageId, {
        body: structuredAgentSessionSendBody(input.text, input.attachments ?? [], input.skills),
        previewUris: (input.attachments ?? []).map((image) => image.previewUri)
      })
      return true
    },
    send: (target) => {
      const current = held()
      sent = true
      reservations.delete(entry.clientMessageId)
      clearTimeout(deadline)
      const sending = current ? dispatchStructuredAgentSessionSend(current, target) : null
      if (sending) {
        void sending.outcome.then(settleReservation)
      }
      return sending
    },
    create: (target) => {
      const current = held()
      if (!current) {
        return null
      }
      sent = true
      reservations.delete(entry.clientMessageId)
      clearTimeout(deadline)
      const remaining = STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS - (Date.now() - current.queuedAt)
      if (remaining <= 0) {
        handBack(current, ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')])
        settleReservation('returned')
        return null
      }
      const sending = beginSend(current, target, remaining)
      const activity = runtimes.get(current.clientMessageId)?.activity
      void sending.outcome.then(settleReservation)
      return {
        ...sending,
        message: { clientMessageId: current.clientMessageId, body: current.body },
        issue: () => {
          if (!runtimes.has(current.clientMessageId)) {
            return false
          }
          activity?.issue()
          updateStructuredAgentSessionPendingSend(current.sessionId, current.clientMessageId, {
            issued: true
          })
          return true
        },
        settle: (result) => {
          activity?.settle(false)
          const pending = findStructuredAgentSessionPendingSend(
            current.sessionId,
            current.clientMessageId
          )
          if (!pending || pending.phase === 'recorded') {
            return
          }
          if (result.kind === 'recorded') {
            settleRecorded(pending, result.submission, 'reply', result.cursor)
          } else if (result.kind === 'unconfirmed') {
            retainUnconfirmed(pending)
          } else if (result.failure) {
            handBackRefused(pending, result.failure)
          } else {
            handBack(pending, agentSessionWriteNotDoneParts('composer-send'))
          }
        }
      }
    },
    release
  }
}

export function settleStructuredAgentSessionSendsFromJournal(
  sessionId: string,
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[],
  cursor?: AgentJournalCursor | null
): void {
  const entries = getStructuredAgentSessionPendingSends(sessionId)
  let facts: ReturnType<typeof structuredAgentSessionSettledSends> | undefined
  const settled = () =>
    (facts ??= structuredAgentSessionSettledSends(submissions, queuedMessageIds))
  settleStructuredLaunchFirstMessageFromJournal(sessionId, () => settled().recorded, cursor)
  if (entries.length === 0) {
    return
  }
  const { cards, recorded } = settled()
  for (const entry of entries) {
    const submission = recorded.get(entry.clientMessageId)
    if (
      cards.has(entry.clientMessageId) ||
      (entry.phase === 'recorded' &&
        structuredAgentSessionReadCoversSend(cursor, entry.recordedCursor))
    ) {
      finish(entry, 'recorded')
    } else if (submission) {
      settleRecorded(entry, submission, 'journal')
    }
  }
}

/** Stop returns unissued sends silently; issued requests settle from their answer without retry. */
export function stopStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    if (!runtime) {
      reservations.get(entry.clientMessageId)?.stop()
    }
    if (runtime && !entry.issued) {
      runtime.abort.abort()
      handBack(entry, null)
    }
  }
}

export function dropStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    reservations.get(entry.clientMessageId)?.drop()
    // Dropped sends are never recorded: their signal ends with them, live runtime or not, and so do
    // their custody grant and hand-back observers (a late attempt finds no entry and issues nothing).
    forgetStructuredAgentSessionSendRecorded(entry.clientMessageId)
    retireStructuredAgentSessionSend(entry.clientMessageId)
    runtime?.abort.abort()
    if (runtime) {
      runtime.activity.settle(false)
      clearTimeout(runtime.deadline)
      runtimes.delete(entry.clientMessageId)
      runtime.resolve('dropped')
    }
  }
  forgetStructuredAgentSessionFence(sessionId)
  clearStructuredAgentSessionPendingSends(sessionId)
}

export function resetStructuredAgentSessionSendsForTests(): void {
  resetStructuredAgentSessionReadOwnersForTests()
  for (const sessionId of structuredAgentSessionsWithPendingSends()) {
    publishStructuredAgentSessionSends(sessionId, { holds: 0 })
    dropStructuredAgentSessionSends(sessionId)
  }
  resetStructuredAgentSessionFencesForTests()
}
