import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess } from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'
import {
  hasSeparateHookSessionAdmission,
  readHookSessionContext
} from './agent-hook-listener/pane-provider-session'
import { extractAgentProviderSession } from './agent-session-resume'
import { resolveAgentStatusIdentity } from './agent-status-identity'

/** Refuse before provider folds can mutate prompt, tool or child state. */
export function isInheritedHookStatus(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): boolean {
  const receivedAt =
    previous && 'receivedAt' in previous && typeof previous.receivedAt === 'number'
      ? previous.receivedAt
      : previous?.hostEvidenceObservedAt
  if (!previous || receivedAt === undefined || !sameAgentStatusTerminalOwner(previous, incoming)) {
    return false
  }
  const preview = previewHookPresence(incoming, previous)
  return resolveAgentStatusIdentity({
    existing: {
      agentType: previous.payload.agentType,
      state: previous.payload.state,
      updatedAt: receivedAt,
      restoredUnconfirmed: previous.restoredUnconfirmed,
      agentPresence: previous.providerSessionOnly ? undefined : preview.owner
    },
    incoming: incoming.payload.agentType,
    incomingProcess: incoming.agentPresence?.process,
    incomingSession: preview.statusAdmissionSession,
    now: Date.now()
  }).inheritedFromActivePane
}

/** Preview an existing association before admission; only the accepted event commits this result. */
export function previewHookPresence<T extends AgentHookEventPayload>(
  incoming: T,
  previous: AgentHookEventPayload | undefined,
  fromHook = true,
  retireBinding = false
) {
  const context = readHookSessionContext(incoming, fromHook)
  if (previous && !sameAgentStatusTerminalOwner(previous, incoming)) {
    previous = undefined
  }
  const recorded = previous?.agentPresence
  const recordedAgent = recorded?.agent
  const scopedSource = hasSeparateHookSessionAdmission(recordedAgent) ? recordedAgent : undefined
  let owner = recorded
  let statusAdmissionSession = context.statusAdmissionSession
  if (scopedSource && retireBinding && recorded) {
    owner = { ...recorded, session: undefined }
  } else if (
    fromHook &&
    scopedSource &&
    recorded &&
    !recorded.ended &&
    !recorded.process &&
    recorded.agent === incoming.payload.agentType &&
    context.event.providerSession
  ) {
    owner = { ...recorded, session: context.event.providerSession.id }
    statusAdmissionSession = context.event.providerSession.id
  }
  const previousBinding =
    previous && owner !== recorded ? { ...previous, agentPresence: owner } : previous
  const matched = Boolean(
    fromHook &&
    scopedSource &&
    owner?.session &&
    !owner.ended &&
    owner.agent === incoming.payload.agentType &&
    owner.session === statusAdmissionSession &&
    (!owner.process ||
      (incoming.agentPresence?.process &&
        isSameAgentProcess(owner.process, incoming.agentPresence.process)))
  )
  return {
    ...context,
    owner,
    statusAdmissionSession,
    transitioned: transitionHookPresence(context.event, previousBinding, fromHook),
    returningProviderSession:
      matched && owner && scopedSource
        ? (extractAgentProviderSession(scopedSource, {
            session_id: owner.session,
            conversationId: owner.session
          }) ?? undefined)
        : undefined
  }
}

/** A pane has one owning agent; only the owner's own proven process can end it. */
function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  fromHook: boolean
): AgentHookEventPayload | undefined {
  const recorded = previous?.agentPresence
  const sender = incoming.agentPresence?.process
  // Only admitted process-ending SessionEnd or host-proved exits mark ended; other SessionEnd events update status.
  const exit = incoming.agentPresence?.ended === true
  // Why: an owner recorded without a process (seen in the terminal before any hook, or from a hook
  // that couldn't capture one) can't speak for liveness, so its agent's first hook that proves a
  // process in the same session claims it. A nested agent's hooks carry another session.
  const unprovenOwnerClaimed =
    sender !== undefined &&
    !exit &&
    recorded !== undefined &&
    !recorded.process &&
    recorded.agent === incoming.agentPresence?.agent &&
    (!recorded.session ||
      recorded.session === (incoming.agentPresence?.session ?? incoming.providerSession?.id))
  const owner =
    recorded &&
    !recorded.ended &&
    !unprovenOwnerClaimed &&
    (!previous?.providerSessionOnly || hasSeparateHookSessionAdmission(recorded.agent))
      ? recorded
      : undefined
  if (owner && (exit || !owner.suspended)) {
    if (exit) {
      const fromOwner = owner.process && sender && isSameAgentProcess(owner.process, sender)
      return fromOwner
        ? {
            ...incoming,
            payload: previous?.payload ?? incoming.payload,
            agentPresence: { ...owner, ended: true }
          }
        : undefined
    }
    if (sender && owner.process && isSameAgentProcess(sender, owner.process)) {
      const session = owner.session
      return session
        ? { ...incoming, agentPresence: { ...owner, ...incoming.agentPresence, session } }
        : incoming
    }
    // Why: nested agents inherit ORCA_PANE_KEY; their hooks update status, never ownership.
    return incoming.agentPresence === owner ? incoming : { ...incoming, agentPresence: owner }
  }
  if (exit) {
    return undefined
  }
  if (
    recorded?.ended &&
    recorded.process &&
    sender &&
    isSameAgentProcess(recorded.process, sender)
  ) {
    return undefined
  }
  const agent = incoming.agentPresence?.agent ?? incoming.payload.agentType
  if (!agent || agent === 'unknown') {
    return incoming.agentPresence ? { ...incoming, agentPresence: undefined } : incoming
  }
  const session = hasSeparateHookSessionAdmission(agent)
    ? agent === incoming.payload.agentType
      ? incoming.providerSession?.id
      : undefined
    : fromHook
      ? (incoming.agentPresence?.session ?? incoming.providerSession?.id)
      : // A terminal observation carries the pane's previous session, not the agent's own.
        undefined
  return {
    ...incoming,
    agentPresence: {
      ...incoming.agentPresence,
      agent,
      ...(sender ? { process: sender } : {}),
      ...(session ? { session } : {})
    }
  }
}
