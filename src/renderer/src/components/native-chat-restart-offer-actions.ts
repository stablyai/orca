import {
  callStructuredAgentSession,
  pairedRestartOffersSupport
} from '@/runtime/structured-agent-session-client'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import {
  announceRestartResults,
  restartContinuationHistory,
  type RestartContinuationOutcome,
  type RestartContinueResult
} from './native-chat-restart-action-notifications'
import {
  projectRestartMachineRows,
  restartMachineTarget,
  type RestartMachineKey
} from './native-chat-restart-machines'
import { restartMachineName } from './native-chat-restart-machine-name'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import {
  currentRestartMachineFence,
  restartMachineCallFence,
  sameRestartMachineFence,
  type RestartMachineFence
} from './native-chat-restart-machine-fence'
import { failedFrom, type HostOfferPayload } from './native-chat-restart-offer-payload'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  beginNativeChatRestartAction,
  getNativeChatRestartOffers,
  publishNativeChatRestartAnswer,
  readNativeChatRestartMachine,
  restartTicketPairingCurrent,
  type NativeChatRestartMachineOffer,
  type RestartMachineRead,
  type RestartMachineTicket
} from './native-chat-resume-on-restart-store'
import { forgetUnsentResumes, markUnsentResumes } from './native-chat-resume-unsent-requests'
import { reopenNativeChatRestartOffer } from './native-chat-restart-offer-reopen'
import type { RestartRunAnswer } from './native-chat-restart-runs'

/**
 * Acting on one machine's offer: continue the chats, or turn them down for good.
 *
 * Every action names the chats it means and is sent under the pairing the offer was listed from:
 * a server re-paired since is refused before anything leaves. A restart of the same server needs no
 * fence — its host re-derives which named chats it still offers, and a dismissal names each chat
 * with the interruption it listed, so a newer one is never deleted by an older listing.
 */

/** The machine's listed offer, if it is still the one the caller saw. */
function currentOffer(
  machine: RestartMachineKey,
  expected: RestartMachineFence | undefined
): NativeChatRestartMachineOffer | 'gone' | 'moved' {
  // A caller holding an older listing (a toast) acts only while the machine is paired the same way.
  if (
    expected !== undefined &&
    !sameRestartMachineFence(expected, currentRestartMachineFence(restartMachineTarget(machine)))
  ) {
    return 'moved'
  }
  const offer = getNativeChatRestartOffers().get(machine)
  if (!offer) {
    return 'gone'
  }
  return expected !== undefined && !sameRestartMachineFence(expected, offer.fence) ? 'moved' : offer
}

/** The server was re-paired under the listing, so the call was refused before anything was sent. */
function refusedAsStale(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'runtime_environment_changed')
}

/** A later request published first: this answer is not the newest, so ask the host again. */
async function publishOrReread(
  ticket: RestartMachineTicket,
  payload: HostOfferPayload
): Promise<void> {
  const published =
    Array.isArray(payload.sessions) &&
    publishNativeChatRestartAnswer(ticket, payload.sessions, failedFrom(payload))
  if (!published && restartTicketPairingCurrent(ticket)) {
    await readNativeChatRestartMachine(ticket.target)
  }
}

/** The toast's Show: the dialog over a fresh read of the failing machine, or of every machine. */
function showResult(machine: RestartMachineKey | null): void {
  void reopenNativeChatRestartOffer(machine ? [machine] : undefined)
}

type ContinueReply = HostOfferPayload & {
  continued?: RestartContinuationOutcome[]
  /** Named chats the host left out of this action; an older host never sends it. */
  skipped?: string[]
}
type RestartFailureRow = Pick<ResumeFailure, 'sessionId' | 'outcome'>

export type RestartContinueRequest = {
  machine: RestartMachineKey
  sessionIds: readonly string[]
}

/** A lost request's chats as the re-read shows them: each one still offered was marked failed.
 *  A paired server may have taken the request and be continuing chats it no longer lists, so those
 *  are unconfirmed rather than dropped; a local request that failed reached nothing. */
function lostRequestFailures(
  read: RestartMachineRead,
  lost: { machine: RestartMachineKey; requested: readonly string[] }
): RestartFailureRow[] | undefined {
  if (read.kind !== 'answered') {
    return undefined
  }
  const offer = getNativeChatRestartOffers().get(lost.machine)
  const failed = offer?.failed ?? []
  if (restartMachineTarget(lost.machine).kind === 'local') {
    return [...failed]
  }
  const listed = new Set([...(offer?.candidates ?? []), ...failed].map((row) => row.sessionId))
  return [
    ...failed,
    ...lost.requested
      .filter((sessionId) => !listed.has(sessionId))
      .map((sessionId) => ({ sessionId, outcome: 'unconfirmed' as const }))
  ]
}

async function continueOnMachine(
  request: RestartContinueRequest,
  expected: RestartMachineFence | undefined
): Promise<RestartContinueResult> {
  const { machine, sessionIds } = request
  const target = restartMachineTarget(machine)
  const base = {
    machine,
    requested: sessionIds,
    ...(target.kind === 'local' ? {} : { machineName: restartMachineName(machine) })
  }
  const offer = currentOffer(machine, expected)
  if (offer === 'gone') {
    return { ...base, kind: 'answered', results: [], hostFailed: [] }
  }
  // Re-paired since the listing: refused before anything is sent or followed.
  if (
    offer === 'moved' ||
    !sameRestartMachineFence(currentRestartMachineFence(target), offer.fence)
  ) {
    return { ...base, kind: 'not-sent' }
  }
  forgetUnsentResumes(machine, sessionIds)
  // The run follows each named chat's progress until the host answers.
  const { ticket, settle } = beginNativeChatRestartAction(target, { listing: offer, sessionIds })
  let answer: RestartRunAnswer | undefined
  if (target.kind === 'local') {
    // `resuming` now names this computer's chats, so the launch's one resume decision is made.
    markNativeChatLaunchResumeDecided()
  }
  try {
    const params = { sessionIds: [...sessionIds] }
    const callFence = restartMachineCallFence(target, offer.fence)
    const result = await (callFence
      ? callStructuredAgentSession<ContinueReply>(
          target,
          'agentSession.restartContinue',
          params,
          callFence
        )
      : callStructuredAgentSession<ContinueReply>(target, 'agentSession.restartContinue', params))
    await publishOrReread(ticket, result)
    const skipped = new Set(Array.isArray(result.skipped) ? result.skipped : [])
    // A chat another action was already resuming is that action's to report.
    const actedOn = sessionIds.filter((sessionId) => !skipped.has(sessionId))
    // A shape this side did not expect counts as unconfirmed: the message may well have gone out.
    const results = Array.isArray(result.continued) ? result.continued : undefined
    const hostFailed = Array.isArray(result.failed)
      ? projectRestartMachineRows(target, failedFrom(result))
      : undefined
    answer = { skipped, continued: restartContinuationHistory(actedOn, results, hostFailed) }
    return { ...base, requested: actedOn, kind: 'answered', results, hostFailed }
  } catch (error) {
    if (refusedAsStale(error)) {
      await readNativeChatRestartMachine(target)
      return { ...base, kind: 'not-sent' }
    }
    // The row's reason is this side's own code, so the real error is kept in the log.
    console.warn('[native-chat-resume] resume request failed or its answer was lost', error)
    markUnsentResumes(machine, sessionIds, Date.now())
    const read = await readNativeChatRestartMachine(target)
    if (read.kind !== 'answered' && target.kind === 'environment') {
      // Neither the answer nor a re-read came back: the server may be continuing every chat.
      return { ...base, kind: 'unconfirmed', listed: getNativeChatRestartOffers().has(machine) }
    }
    return { ...base, kind: 'answered', results: [], hostFailed: lostRequestFailures(read, base) }
  } finally {
    settle(answer)
  }
}

/**
 * Reattach the named chats on each machine, ask each agent to carry on, then replace each machine's
 * offer with its host's authoritative remaining list.
 *
 * Ends in one toast saying what it did across every machine it reached, whether a click, a toast or
 * an opted-in automatic resume started it; each chat's note stays the record. `sessionIds` always
 * names the chats: an action never continues one this side did not choose, which on a shared server
 * could be another device's. `expected` is the listing a caller saw (a toast), which acts only
 * while the machine is still paired that way.
 *
 * Never rejects; a lost answer is followed by a re-read, never a retry. The chats a lost request
 * named that the host still offers show as failed, with Retry. A request refused because the
 * server was re-paired counts as not resumed.
 */
export async function continueNativeChatRestartOffers(
  requests: readonly RestartContinueRequest[],
  options: { expected?: RestartMachineFence } = {}
): Promise<void> {
  const results = await Promise.all(
    requests
      .filter((request) => request.sessionIds.length > 0)
      .map((request) => continueOnMachine(request, options.expected))
  )
  announceRestartResults(results, showResult)
}

/** The offers a named dismissal lists back to the host, each with the interruption it showed. */
function listedOffers(offer: NativeChatRestartMachineOffer, sessionIds: readonly string[]) {
  const named = new Set(sessionIds)
  return [...offer.candidates, ...offer.failed]
    .filter((row) => named.has(row.sessionId))
    .map((row) => ({ sessionId: row.sessionId, recordedAt: row.recordedAt }))
}

/**
 * Turning offers down for good, which explicitly deletes the durable records.
 *
 * This computer may dismiss everything it listed by naming nothing. A paired server is always told
 * which chats: unnamed, its dismissal would delete every device's offers. A server is only ever
 * listed when it advertises named dismissal, so one that does not is never sent one.
 *
 * Says nothing either way: the dialog row going away is the answer. A refused or lost dismissal
 * leaves the durable record untouched and re-reads the list, which puts it back.
 */
export async function dismissNativeChatRestartOffer(
  machine: RestartMachineKey,
  sessionIds?: readonly string[],
  expected?: RestartMachineFence
): Promise<void> {
  const offer = currentOffer(machine, expected)
  if (offer === 'gone') {
    return
  }
  const target = restartMachineTarget(machine)
  if (offer === 'moved') {
    void readNativeChatRestartMachine(target)
    return
  }
  const named =
    target.kind === 'environment'
      ? (sessionIds ?? [...offer.candidates, ...offer.failed].map((row) => row.sessionId))
      : sessionIds
  if (named?.length === 0) {
    return
  }
  if (target.kind === 'environment') {
    // Checked again rather than assumed from the listing: never an unnamed or unknown dismissal.
    const support = await pairedRestartOffersSupport(target.environmentId)
    if (support !== 'supported') {
      void readNativeChatRestartMachine(target)
      return
    }
  }
  const { ticket, settle } = beginNativeChatRestartAction(target)
  try {
    const params = named ? { sessionIds: [...named], offers: listedOffers(offer, named) } : {}
    const callFence = restartMachineCallFence(target, offer.fence)
    const result = await (callFence
      ? callStructuredAgentSession<HostOfferPayload>(
          target,
          'agentSession.restartResumableDismiss',
          params,
          callFence
        )
      : callStructuredAgentSession<HostOfferPayload>(
          target,
          'agentSession.restartResumableDismiss',
          params
        ))
    // Only a dismissal the host took ends the marks; a failed one leaves the chats shown as failed.
    forgetUnsentResumes(machine, named)
    await publishOrReread(ticket, result)
  } catch {
    await readNativeChatRestartMachine(target)
  } finally {
    settle()
  }
}
