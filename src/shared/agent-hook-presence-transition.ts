import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess } from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'
import {
  hasSeparateHookSessionAdmission,
  readHookSessionContext
} from './agent-hook-listener/pane-provider-session'
import { extractAgentProviderSession } from './agent-session-resume'
import { resolveAgentStatusIdentity } from './agent-status-identity'
import type { HookProcessVerdict } from './hook-process-root-evidence'

/** Refuse before provider folds can mutate prompt, tool or child state. */
export function isInheritedHookStatus(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  rootVerdict?: HookProcessVerdict
): boolean {
  const receivedAt =
    previous && 'receivedAt' in previous && typeof previous.receivedAt === 'number'
      ? previous.receivedAt
      : previous?.hostEvidenceObservedAt
  if (!previous || receivedAt === undefined || !sameAgentStatusTerminalOwner(previous, incoming)) {
    return false
  }
  const preview = previewHookPresence(incoming, previous, true, false, rootVerdict)
  if (preview.acquired) {
    return false
  }
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
  retireBinding = false,
  rootVerdict?: HookProcessVerdict,
  /** The relay's pane binding for a root verdict, echoed on the owner it proves. */
  rootBinding?: string
) {
  const context = readHookSessionContext(incoming, fromHook)
  if (previous && !sameAgentStatusTerminalOwner(previous, incoming)) {
    previous = undefined
  }
  const exit = incoming.agentPresence?.ended === true
  const sender = incoming.agentPresence?.process
  const prior = previous?.agentPresence
  // Why: a fallback was recorded without proof; once this host proves its process is not the
  // pane's own job it keeps the status and loses the process. A relay withdrawing its own
  // fallback forwards the process-less association it kept, which this host mirrors.
  const withdrawn = Boolean(
    fromHook &&
    prior?.fallback &&
    !prior.ended &&
    prior.process &&
    (sender
      ? isSameAgentProcess(prior.process, sender) &&
        (rootVerdict === 'nested' || rootVerdict === 'competing' || rootVerdict === 'unattached')
      : !exit && Boolean(incoming.connectionId) && incoming.agentPresence?.agent === prior.agent)
  )
  if (withdrawn && prior && previous) {
    previous = {
      ...previous,
      agentPresence: { agent: prior.agent, ...(prior.session ? { session: prior.session } : {}) }
    }
  }
  // Why: the execution host proved this process is the pane's own agent, which outranks an
  // association that never proved a process, whatever its agent or session.
  const acquired = fromHook && rootVerdict === 'root' && !exit
  if (acquired && previous?.agentPresence) {
    previous = { ...previous, agentPresence: undefined }
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
  const refused =
    fromHook && !withdrawn && (rootVerdict === 'nested' || rootVerdict === 'competing')
  const owned =
    recorded &&
    !recorded.ended &&
    (!previous?.providerSessionOnly || hasSeparateHookSessionAdmission(recorded.agent))
  let event = context.event
  if (acquired && event.agentPresence) {
    const { fallback: _fallback, ...proved } = event.agentPresence
    event = { ...event, agentPresence: rootBinding ? { ...proved, paneRoot: rootBinding } : proved }
  } else if (
    fromHook &&
    !exit &&
    (rootVerdict === 'unknown' || rootVerdict === 'unattached') &&
    !(recorded?.process && sender && isSameAgentProcess(recorded.process, sender))
  ) {
    // Unproven evidence records nothing over an association; into an empty slot a generic unknown
    // keeps main's captured process as a fallback, while an unverified tmux session stays status-only.
    event =
      rootVerdict === 'unknown' && !owned && event.agentPresence?.process
        ? { ...event, agentPresence: { ...event.agentPresence, fallback: true as const } }
        : { ...event, agentPresence: undefined }
  }
  // Why: the pane's proven root exiting ends the same agent's unproven or fallback record it
  // could never prove; only its own exit retires it, once, without first naming it a live owner.
  const retiring =
    fromHook &&
    exit &&
    rootVerdict === 'root' &&
    !previous?.providerSessionOnly &&
    !recorded?.ended &&
    (!recorded?.process || recorded.fallback) &&
    recorded?.agent === incoming.agentPresence?.agent
      ? recorded
      : undefined
  const session = context.event.providerSession?.id ?? retiring?.session
  const transitioned = retiring
    ? {
        ...context.event,
        payload: previous?.payload ?? incoming.payload,
        agentPresence: {
          ...incoming.agentPresence,
          agent: retiring.agent,
          ...(session ? { session } : {}),
          ...(rootBinding ? { paneRoot: rootBinding } : {}),
          ended: true as const
        }
      }
    : refused
      ? undefined
      : transitionHookPresence(event, previousBinding, fromHook)
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
    acquired,
    transitioned,
    /** Only an admitted exit from the owner's process ends it; a carried retirement record does not. */
    exited: fromHook && transitioned?.agentPresence?.ended === true,
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
  const owner =
    recorded &&
    !recorded.ended &&
    (!previous?.providerSessionOnly || hasSeparateHookSessionAdmission(recorded.agent))
      ? recorded
      : undefined
  if (!fromHook) {
    // Why: a terminal or inferred report proves no process or session, so it keeps the recorded
    // association as it is (suspended and retired ones too) and never names an owner itself.
    const kept = owner ?? (recorded?.ended ? recorded : undefined)
    return incoming.agentPresence === kept ? incoming : { ...incoming, agentPresence: kept }
  }
  const fromOwner = Boolean(owner?.process && sender && isSameAgentProcess(owner.process, sender))
  // Suspension blocks a replacement, never the owner's own process resuming.
  if (owner && (exit || fromOwner || !owner.suspended)) {
    if (exit) {
      return fromOwner
        ? {
            ...incoming,
            payload: previous?.payload ?? incoming.payload,
            agentPresence: { ...owner, ended: true }
          }
        : undefined
    }
    if (fromOwner) {
      // The owner's own hook keeps how it was recorded: a fallback is never proved by itself.
      const { suspended: _suspended, session, ...kept } = owner
      return {
        ...incoming,
        agentPresence: { ...kept, ...incoming.agentPresence, ...(session ? { session } : {}) }
      }
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
    : (incoming.agentPresence?.session ?? incoming.providerSession?.id)
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
