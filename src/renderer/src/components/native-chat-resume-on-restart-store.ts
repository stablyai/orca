import { useSyncExternalStore } from 'react'
import {
  callStructuredAgentSession,
  pairedRestartOffersSupport
} from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  failedFrom,
  hostCannotOffer,
  type HostOfferPayload
} from './native-chat-restart-offer-payload'
import { consumeNativeChatResumeOnRestartDialogRequest } from './native-chat-resume-on-restart-dialog'
import {
  projectRestartMachineRows,
  restartMachineKey,
  restartMachineTarget,
  type RestartMachineKey
} from './native-chat-restart-machines'
import {
  currentRestartMachineFence,
  restartMachineCallFence,
  sameRestartMachineFence,
  type RestartMachineFence
} from './native-chat-restart-machine-fence'
import {
  releaseOfferedChatWatches,
  syncOfferedChatWatch
} from './native-chat-restart-offer-activity-watch'
import {
  _resetUnsentResumes,
  forgetUnsentResumes,
  withUnsentResumes
} from './native-chat-resume-unsent-requests'
import {
  _resetNativeChatRestartRuns,
  beginNativeChatRestartRun,
  forgetNativeChatRestartRun,
  getNativeChatRestartRuns,
  type RestartRunAnswer
} from './native-chat-restart-runs'

export {
  getNativeChatRestartResuming,
  useNativeChatRestartResuming
} from './native-chat-restart-runs'

/**
 * Which interrupted chats each machine is still offering to resume, and every action that moves
 * that. A machine is this computer or one paired server; each answers for its own chats.
 *
 * The offer is each HOST's answer, shared by the dialog, the status bar and the reconnect toast
 * rather than held by whichever rendered first. Opening a chat is intentionally read-only; only an
 * explicit action changes the durable offer.
 *
 * One publication rule per machine: every request (read, continue, dismiss) takes a ticket and the
 * machine's pairing when it is issued, and its answer is published only if no later-issued request
 * has published since and the machine is still paired the same way.
 */

export type NativeChatRestartMachineOffer = Readonly<{
  machine: RestartMachineKey
  target: RuntimeClientTarget
  /** Host ids already in this desktop's terms (a paired server's `local` is its runtime host). */
  candidates: readonly ResumeCandidate[]
  /** Acted-on offers whose agent did not carry on, as the host still records them. */
  failed: readonly ResumeFailure[]
  /** The pairing this answer came from; every action on it is sent with it. */
  fence: RestartMachineFence
  /** Stamped when the list arrived. Row ages read against this rather than a render-time
   *  `Date.now()`, so they stay stable across re-renders and the render stays pure. */
  listedAt: number
}>

export type NativeChatRestartOffers = ReadonlyMap<RestartMachineKey, NativeChatRestartMachineOffer>

/** `unavailable` is not an answer: the machine keeps the last one it gave. `unsupported` is an
 *  older or chat-less host that has no offers to give. `published` says whether this answer is the
 *  one the machine now shows; only that one may decide anything. */
export type RestartMachineRead =
  | {
      kind: 'answered'
      candidates: readonly ResumeCandidate[]
      failed: readonly ResumeFailure[]
      published: boolean
    }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }

/** A request's claim on publishing its answer: issue order, and the pairing it was sent under. */
export type RestartMachineTicket = Readonly<{
  machine: RestartMachineKey
  target: RuntimeClientTarget
  ticket: number
  fence: RestartMachineFence
}>

const NO_OFFERS: NativeChatRestartOffers = new Map()
let offers: NativeChatRestartOffers = NO_OFFERS
const ticketsIssued = new Map<RestartMachineKey, number>()
const ticketsPublished = new Map<RestartMachineKey, number>()
/** Continue and dismiss calls in flight per machine; a chat-activity re-read waits for them. */
const actionsInFlight = new Map<RestartMachineKey, number>()
const listeners = new Set<() => void>()
let readListener:
  | ((target: RuntimeClientTarget, candidates: readonly ResumeCandidate[]) => void)
  | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function hasRows(offer: NativeChatRestartMachineOffer | undefined): boolean {
  return Boolean(offer && (offer.candidates.length > 0 || offer.failed.length > 0))
}

/** The snapshot object is replaced HERE and nowhere else — never during a render — so every
 *  `useSyncExternalStore` reader sees the same reference until a host answer or a user action
 *  actually moves an offer. */
function publish(machine: RestartMachineKey, next: NativeChatRestartMachineOffer | null): void {
  const updated = new Map(offers)
  if (next && hasRows(next)) {
    updated.set(machine, next)
  } else {
    updated.delete(machine)
  }
  offers = updated.size === 0 ? NO_OFFERS : updated
  syncOfferedChatWatch(machine, offers.get(machine), refreshAfterOfferedChatActivity)
  emit()
  retireRequestWithNothingToDraw()
}

/** With nothing left on any machine and no run to follow, an open request has nothing to show. */
function retireRequestWithNothingToDraw(): void {
  if (offers.size === 0 && getNativeChatRestartRuns().size === 0) {
    consumeNativeChatResumeOnRestartDialogRequest()
  }
}

export function issueNativeChatRestartTicket(target: RuntimeClientTarget): RestartMachineTicket {
  const machine = restartMachineKey(target)
  const ticket = (ticketsIssued.get(machine) ?? 0) + 1
  ticketsIssued.set(machine, ticket)
  return { machine, target, ticket, fence: currentRestartMachineFence(target) }
}

/** Whether the machine is still paired the way the request was sent. */
export function restartTicketPairingCurrent(ticket: RestartMachineTicket): boolean {
  return sameRestartMachineFence(ticket.fence, currentRestartMachineFence(ticket.target))
}

/** Publishes under the one rule; false when a later request already published or the pairing moved. */
function publishUnder(
  ticket: RestartMachineTicket,
  rows: { candidates: readonly ResumeCandidate[]; failed: readonly ResumeFailure[] } | null
): boolean {
  if (
    ticket.ticket <= (ticketsPublished.get(ticket.machine) ?? 0) ||
    !restartTicketPairingCurrent(ticket)
  ) {
    return false
  }
  ticketsPublished.set(ticket.machine, ticket.ticket)
  if (!rows) {
    forgetUnsentResumes(ticket.machine, undefined)
  }
  const shown = rows && withUnsentResumes(ticket.machine, rows)
  publish(
    ticket.machine,
    shown && {
      machine: ticket.machine,
      target: ticket.target,
      fence: ticket.fence,
      candidates: projectRestartMachineRows(ticket.target, shown.candidates),
      failed: projectRestartMachineRows(ticket.target, shown.failed),
      listedAt: Date.now()
    }
  )
  return true
}

/** A host answer to an action; false when it was superseded and the caller should read again. */
export function publishNativeChatRestartAnswer(
  ticket: RestartMachineTicket,
  candidates: readonly ResumeCandidate[],
  failed: readonly ResumeFailure[]
): boolean {
  return publishUnder(ticket, { candidates, failed })
}

function refreshAfterOfferedChatActivity(machine: RestartMachineKey): void {
  // An action in flight ends with the host's answer, or a read of its own if a later one won.
  if ((actionsInFlight.get(machine) ?? 0) === 0) {
    void readNativeChatRestartMachine(restartMachineTarget(machine))
  }
}

export function getNativeChatRestartOffers(): NativeChatRestartOffers {
  return offers
}

export function subscribeNativeChatRestartOffers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Told of every read whose answer was published, so decisions follow the answer itself. */
export function setNativeChatRestartReadListener(
  listener: ((target: RuntimeClientTarget, candidates: readonly ResumeCandidate[]) => void) | null
): void {
  readListener = listener
}

async function readPairedSupport(
  ticket: RestartMachineTicket,
  environmentId: string
): Promise<RestartMachineRead | null> {
  // Asking a paired host that cannot answer without building its chat host would open its journal
  // on a server that may never have run a chat; such a host is never asked.
  const support = await pairedRestartOffersSupport(environmentId)
  if (!restartTicketPairingCurrent(ticket) || support === 'unknown') {
    // Re-paired while probing, or the probe failed: nothing is known about this server.
    return { kind: 'unavailable' }
  }
  if (support === 'unsupported') {
    // A server rolled back to a build without it keeps nothing listed that it can no longer act on.
    publishUnder(ticket, null)
    return { kind: 'unsupported' }
  }
  return null
}

/**
 * Re-reads one machine's answer.
 *
 * A failed read is not an answer and leaves that machine's last answer in place: loss of contact
 * is never evidence the offer is gone, and an action re-derives eligibility on the host anyway.
 */
export async function readNativeChatRestartMachine(
  target: RuntimeClientTarget
): Promise<RestartMachineRead> {
  // Taken before any await, so the probe and the read both answer for the pairing they asked.
  const ticket = issueNativeChatRestartTicket(target)
  if (target.kind === 'environment') {
    const refused = await readPairedSupport(ticket, target.environmentId)
    if (refused) {
      return refused
    }
  }
  const callFence = restartMachineCallFence(target, ticket.fence)
  try {
    const offered = await (callFence
      ? callStructuredAgentSession<HostOfferPayload>(
          target,
          'agentSession.restartResumable',
          undefined,
          callFence
        )
      : callStructuredAgentSession<HostOfferPayload>(target, 'agentSession.restartResumable'))
    if (!Array.isArray(offered.sessions)) {
      throw new Error('agent_session_restart_offer_invalid')
    }
    const candidates: ResumeCandidate[] = offered.sessions
    const failed = failedFrom(offered)
    const published = publishUnder(ticket, { candidates, failed })
    const projected = projectRestartMachineRows(target, candidates)
    if (published) {
      readListener?.(target, projected)
    }
    return {
      kind: 'answered',
      candidates: projected,
      failed: projectRestartMachineRows(target, failed),
      published
    }
  } catch (error) {
    if (hostCannotOffer(error)) {
      publishUnder(ticket, null)
      return { kind: 'unsupported' }
    }
    return { kind: 'unavailable' }
  }
}

/** A machine this desktop no longer pairs with: its offers are not this desktop's to show, and no
 *  answer to a request already in flight may bring them back. */
export function forgetNativeChatRestartMachine(machine: RestartMachineKey): void {
  const ticket = issueNativeChatRestartTicket(restartMachineTarget(machine))
  ticketsPublished.set(machine, ticket.ticket)
  forgetUnsentResumes(machine, undefined)
  forgetNativeChatRestartRun(machine)
  if (offers.has(machine)) {
    publish(machine, null)
  } else {
    // Its run may have been all an open dialog showed.
    retireRequestWithNothingToDraw()
  }
}

/** Bookkeeping for an action (continue or dismiss) on one machine: its ticket, and for a resume, the
 *  run that follows its chats until the host answers. Used by the action module. */
export function beginNativeChatRestartAction(
  target: RuntimeClientTarget,
  resume?: { listing: NativeChatRestartMachineOffer; sessionIds: readonly string[] }
): { ticket: RestartMachineTicket; settle: (answer?: RestartRunAnswer) => void } {
  const ticket = issueNativeChatRestartTicket(target)
  actionsInFlight.set(ticket.machine, (actionsInFlight.get(ticket.machine) ?? 0) + 1)
  const finishRun = resume && beginNativeChatRestartRun(resume.listing, resume.sessionIds)
  return {
    ticket,
    settle: (answer) => {
      actionsInFlight.set(ticket.machine, (actionsInFlight.get(ticket.machine) ?? 1) - 1)
      finishRun?.(answer)
    }
  }
}

export function useNativeChatRestartOffers(): NativeChatRestartOffers {
  return useSyncExternalStore(
    subscribeNativeChatRestartOffers,
    getNativeChatRestartOffers,
    getNativeChatRestartOffers
  )
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartOfferState(): void {
  releaseOfferedChatWatches()
  offers = NO_OFFERS
  _resetUnsentResumes()
  _resetNativeChatRestartRuns()
  actionsInFlight.clear()
  ticketsIssued.clear()
  ticketsPublished.clear()
  listeners.clear()
  readListener = null
}
