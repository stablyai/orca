import type { AgentJournalCursor } from '../../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import type { AgentSessionWriteFailure } from '../../../../../../../shared/agent-session/failures/agent-session-write-failure'
import { dispatchWasWithdrawn } from '../../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { agentSessionWriteNoticeText } from '../../../messages/notices/agent-session-write-notice-text'
import { getStructuredAgentSessionReadOwner } from '../read/structured-agent-session-read-owner'
import { nativeChatRewindReasonCopy } from '../../../messages/actions/native-chat-rewind-copy'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import {
  findStructuredAgentSessionPendingSend,
  publishStructuredAgentSessionSends,
  structuredAgentSessionSendsWatched,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

export const STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS = 30_000

export type StructuredAgentSessionSendOutcome = 'recorded' | 'returned' | 'unconfirmed' | 'dropped'

type SendRuntime = {
  activity: ReturnType<ReturnType<typeof getStructuredAgentSessionReadOwner>['trackSend']>
  target: RuntimeClientTarget
  abort: AbortController
  deadline: ReturnType<typeof setTimeout>
  resolve: (outcome: StructuredAgentSessionSendOutcome) => void
}

export const runtimes = new Map<string, SendRuntime>()
// One per send operation, made when the send (or its reservation) is: resolves once the host records it,
// even after an `unconfirmed` first outcome and with the live runtime gone. Holders get it from the
// send itself, so a recording can never land before they subscribe.
const recordedSignals = new Map<string, { promise: Promise<void>; resolve: () => void }>()

/** The send operation's recorded signal; the same promise for every call until the send ends. */
export function structuredAgentSessionSendRecorded(clientMessageId: string): Promise<void> {
  let signal = recordedSignals.get(clientMessageId)
  if (!signal) {
    let resolve = (): void => {}
    const promise = new Promise<void>((done) => (resolve = done))
    signal = { promise, resolve }
    recordedSignals.set(clientMessageId, signal)
  }
  return signal.promise
}

/** The send ended without a recording (returned, dropped, released): its signal will never resolve. */
export function forgetStructuredAgentSessionSendRecorded(clientMessageId: string): void {
  recordedSignals.delete(clientMessageId)
}

export function finish(
  entry: StructuredAgentSessionPendingSend,
  outcome: StructuredAgentSessionSendOutcome,
  keep?: Partial<StructuredAgentSessionPendingSend>
): void {
  if (outcome === 'recorded') {
    recordedSignals.get(entry.clientMessageId)?.resolve()
  }
  if (outcome !== 'unconfirmed') {
    forgetStructuredAgentSessionSendRecorded(entry.clientMessageId)
  }
  const runtime = runtimes.get(entry.clientMessageId)
  if (runtime) {
    runtime.activity.settle(false)
    clearTimeout(runtime.deadline)
    runtimes.delete(entry.clientMessageId)
    runtime.resolve(outcome)
  }
  retireStructuredAgentSessionSend(entry.clientMessageId)
  updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, keep ?? null)
}

/**
 * The attempt-scoped delivery authority a send's preparation granted: what it returns are the browser
 * originals this send has since lost custody of (adopted by another draft). A send with any is issued
 * nowhere: custody moves with the original, and so does the right to deliver its upload.
 */
const sendCustody = new Map<string, () => readonly string[]>()

export function grantStructuredAgentSessionSendCustody(
  clientMessageId: string,
  lost: () => readonly string[]
): void {
  sendCustody.set(clientMessageId, lost)
}

export function revokeStructuredAgentSessionSendCustody(clientMessageId: string): void {
  sendCustody.delete(clientMessageId)
}

/** The originals this send may no longer deliver; empty while its grant holds (or it needs none). */
export function structuredAgentSessionSendCustodyLost(clientMessageId: string): readonly string[] {
  return sendCustody.get(clientMessageId)?.() ?? []
}

/**
 * What a hand-back left of the returned input. `durable`: installed in its draft and journaled, so it
 * survives a reload. `installed`: in the draft, but only the pending storage write can make it durable
 * (a refused write shows the draft's own not-saved mark). `lost`: putting it back threw. `caller`: the
 * caller kept the text. Ending the send never depends on it; whoever retires another copy does.
 */
export type StructuredAgentSessionHandBackCustody = 'durable' | 'installed' | 'lost' | 'caller'

type HandBackObserver = (custody: StructuredAgentSessionHandBackCustody) => void
// Every holder of the send (its reservation, and the send itself once it begins) hears the same result.
const handBackObservers = new Map<string, Set<HandBackObserver>>()

/** Hear this send's hand-back, before its outcome settles. */
export function observeStructuredAgentSessionHandBack(
  clientMessageId: string,
  observer: HandBackObserver
): () => void {
  const observers = handBackObservers.get(clientMessageId) ?? new Set()
  observers.add(observer)
  handBackObservers.set(clientMessageId, observers)
  return () => {
    observers.delete(observer)
    if (observers.size === 0 && handBackObservers.get(clientMessageId) === observers) {
      handBackObservers.delete(clientMessageId)
    }
  }
}

/** The send ended: nothing will hand it back, and nothing waits for its custody grant any more. */
export function retireStructuredAgentSessionSend(clientMessageId: string): void {
  handBackObservers.delete(clientMessageId)
  sendCustody.delete(clientMessageId)
}

function returnToComposer(
  entry: StructuredAgentSessionPendingSend,
  expiredUploadIds?: ReadonlySet<string>,
  restoredUploadIds?: Set<string>
): Exclude<StructuredAgentSessionHandBackCustody, 'caller'> {
  try {
    return handBackStructuredAgentSessionMessage(
      entry.sessionId,
      entry.clientMessageId,
      entry.body,
      entry.imageConnectionIds,
      expiredUploadIds,
      restoredUploadIds
    )
      ? 'durable'
      : 'installed'
  } catch (error) {
    console.error('[native-chat-send] a message could not be put back in the composer', error)
    return 'lost'
  }
}

type HandBackNotice =
  | readonly AgentSessionWriteNoticePart[]
  | null
  /** Worded once the hand-back knows which expired uploads came back as their originals. */
  | ((restoredUploadIds: ReadonlySet<string>) => readonly AgentSessionWriteNoticePart[] | null)

export function handBack(
  entry: StructuredAgentSessionPendingSend,
  notice: HandBackNotice,
  expiredUploadIds?: ReadonlySet<string>
): void {
  let custody: StructuredAgentSessionHandBackCustody = 'caller'
  try {
    if (entry.callerKeepsText) {
      return
    }
    const restored = new Set<string>()
    custody = returnToComposer(entry, expiredUploadIds, restored)
    const words = typeof notice === 'function' ? notice(restored) : notice
    const parts: readonly AgentSessionWriteNoticePart[] | null =
      custody === 'lost' ? [...(words ?? []), 'messageNotSaved'] : words
    if (parts?.length) {
      publishStructuredAgentSessionSends(entry.sessionId, {
        notice: agentSessionWriteNoticeText(parts)
      })
    }
  } finally {
    const observers = [...(handBackObservers.get(entry.clientMessageId) ?? [])]
    handBackObservers.delete(entry.clientMessageId)
    for (const observer of observers) {
      try {
        observer(custody)
      } catch (error) {
        console.error('[native-chat-send] a hand-back observer failed', error)
      }
    }
    // Bookkeeping never holds the chat: whatever the hand-back met, the send ends.
    finish(entry, 'returned')
  }
}

export function retainUnconfirmed(entry: StructuredAgentSessionPendingSend): void {
  finish(entry, 'unconfirmed', { phase: 'unconfirmed' })
}

/** Settled by the host's answer, from the send's own reply or the journal, whichever comes first. */
export function settleRecorded(
  entry: StructuredAgentSessionPendingSend,
  submission: AgentJournalSubmission | null,
  from: 'reply' | 'journal',
  cursor?: AgentJournalCursor | null
): void {
  // Stop-withdrawn messages stay in host history; otherwise retain recorded echoes until rows catch up with replies.
  const keep =
    from === 'reply' &&
    !(submission && dispatchWasWithdrawn(submission)) &&
    structuredAgentSessionSendsWatched(entry.sessionId)
  finish(
    entry,
    'recorded',
    keep
      ? { phase: 'recorded', issued: true, ...(cursor ? { recordedCursor: cursor } : {}) }
      : undefined
  )
}

/** Unconfirmed rewind blocks sends until the host checks it again; use the rewind-specific refusal words. */
function refusedSendParts(failure: AgentSessionWriteFailure): AgentSessionWriteNoticePart[] {
  return failure.kind === 'refused' && failure.details?.reason === 'rewindUnconfirmed'
    ? [
        { text: nativeChatRewindReasonCopy('outcome-unknown') },
        ...agentSessionWriteNotDoneParts('composer-send')
      ]
    : agentSessionWriteNoticeParts(failure, 'composer-send')
}

/**
 * Return a refused message, marking any image the host said expired. The notice names only the expired
 * attachments that did not come back as their originals; when all did, nothing is left to attach again
 * and the message is simply not sent yet.
 */
export function handBackRefused(
  entry: StructuredAgentSessionPendingSend,
  failure: AgentSessionWriteFailure
): void {
  const invalid =
    failure.kind === 'refused' && failure.code === 'agent_session_operation_invalid'
      ? failure
      : undefined
  const expired = invalid?.details?.expiredAttachments
  handBack(
    entry,
    (restored) => {
      const unrecovered = expired?.filter(({ uploadId }) => !restored.has(uploadId)) ?? []
      if (!invalid || !expired || unrecovered.length === expired.length) {
        return refusedSendParts(failure)
      }
      return unrecovered.length
        ? refusedSendParts({
            ...invalid,
            details: { ...invalid.details, expiredAttachments: unrecovered }
          })
        : agentSessionWriteNotDoneParts('composer-send')
    },
    expired && new Set(expired.map(({ uploadId }) => uploadId))
  )
}

function onDeadline(sessionId: string, clientMessageId: string): void {
  const entry = findStructuredAgentSessionPendingSend(sessionId, clientMessageId)
  if (!entry || entry.phase === 'recorded') {
    return
  }
  runtimes.get(clientMessageId)?.abort.abort()
  if (entry.issued) {
    retainUnconfirmed(entry)
  } else {
    handBack(entry, ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')])
  }
}

export type StructuredAgentSessionSent = {
  clientMessageId: string
  outcome: Promise<StructuredAgentSessionSendOutcome>
  /** Resolves once the host records this send, including after an `unconfirmed` outcome. */
  recorded: Promise<void>
  /**
   * What this send's hand-back left of its input, heard before a `returned` outcome settles;
   * undefined when nothing handed it back. A `returned` outcome alone says only that the send ended.
   */
  handedBack: () => StructuredAgentSessionHandBackCustody | undefined
}

export function beginSend(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget,
  budgetMs = STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS
): StructuredAgentSessionSent {
  const { clientMessageId, sessionId } = entry
  const owner = getStructuredAgentSessionReadOwner(sessionId, target)
  updateStructuredAgentSessionPendingSend(sessionId, clientMessageId, {
    afterSequence: owner.getSnapshot().state.cursor?.sequence
  })
  const recorded = structuredAgentSessionSendRecorded(clientMessageId)
  let handedBack: StructuredAgentSessionHandBackCustody | undefined
  // Retired with the send (see `retireStructuredAgentSessionSend`): no observer outlives it.
  observeStructuredAgentSessionHandBack(clientMessageId, (custody) => {
    handedBack = custody
  })
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    runtimes.set(clientMessageId, {
      activity: owner.trackSend(clientMessageId),
      target,
      abort: new AbortController(),
      deadline: setTimeout(() => onDeadline(sessionId, clientMessageId), budgetMs),
      resolve
    })
  })
  return { clientMessageId, outcome, recorded, handedBack: () => handedBack }
}
