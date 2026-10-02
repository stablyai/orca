import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess, type AgentProcessPresence } from './agent-process-presence'

/** A hook from another live process doubts the recorded owner. Returns undefined when it raises no
 *  doubt; otherwise the process that takes the pane if the owner proves dead (none when the sender
 *  names no agent, so it can only trigger the recheck). */
export function ownerDoubtFromHook(
  incoming: AgentHookEventPayload,
  row: AgentHookEventPayload
): { successor?: AgentProcessPresence } | undefined {
  const sender = incoming.agentPresence?.process
  const owner = row.agentPresence
  if (!sender || !owner?.process || owner.ended || isSameAgentProcess(sender, owner.process)) {
    return undefined
  }
  const agent = incoming.agentPresence?.agent ?? incoming.payload.agentType
  return agent && agent !== 'unknown' ? { successor: { agent, process: sender } } : {}
}

/** Every host hands a proven-dead owner's pane to the doubting process with the status it reported,
 *  so the pane never shows an exit while that process runs. Apply it with `ownerProvenDead`. */
export function handOverDeadOwner(
  row: AgentHookEventPayload,
  successor: AgentProcessPresence
): AgentHookEventPayload {
  return { ...row, agentPresence: successor }
}

/** A pane has one owning agent; only the owner's own proven process can end it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  options?: { ownerProvenDead?: boolean }
): AgentHookEventPayload | undefined {
  const recorded = previous?.agentPresence
  // Dismissing a turn does not release its identified process owner.
  const owner =
    recorded && !recorded.ended && (recorded.process || !previous?.providerSessionOnly)
      ? recorded
      : undefined
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
    if (options?.ownerProvenDead && sender) {
      return incoming
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
