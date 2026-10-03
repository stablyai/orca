import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess } from './agent-process-presence'

/** A retained identity-only row outlives its agent; it is evidence, never the pane's owner. */
export function isRetainedSessionRemnant(row: AgentHookEventPayload | undefined): boolean {
  return row?.providerSessionOnly === true
}

/** A pane has one owning agent; only the owner's own proven process can end it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  const recorded = previous?.agentPresence
  const owner =
    recorded && !recorded.ended && !isRetainedSessionRemnant(previous) ? recorded : undefined
  const sender = incoming.agentPresence?.process
  // Why: only an admitted exit is marked ended (Claude's process-ending SessionEnd, or a host-proved
  // exit); other agents' SessionEnd hooks are ordinary status updates.
  const exit = incoming.agentPresence?.ended === true
  if (owner) {
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
  return { ...incoming, agentPresence: { agent, ...(sender ? { process: sender } : {}) } }
}
