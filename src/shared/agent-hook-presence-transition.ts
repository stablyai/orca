import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess } from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'

/** A pane has one owning agent; only the owner's own proven process can end it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  if (previous && !sameAgentStatusTerminalOwner(previous, incoming)) {
    previous = undefined
  }
  const recorded = previous?.agentPresence
  const owner = recorded && !recorded.ended && !previous?.providerSessionOnly ? recorded : undefined
  const sender = incoming.agentPresence?.process
  // Only admitted process-ending SessionEnd or host-proved exits mark ended; other SessionEnd events update status.
  const exit = incoming.agentPresence?.ended === true
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
  const session = incoming.agentPresence?.session ?? incoming.providerSession?.id
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
