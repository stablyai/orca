import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentProcessPresence } from './agent-process-presence'

/** Hooks can prompt a check, but cannot provide a successor process. */
export function ownerDoubtFromHook(
  incoming: AgentHookEventPayload,
  owner: AgentProcessPresence | undefined
): boolean {
  return Boolean(
    owner?.process &&
    !owner.ended &&
    (incoming.hookEventName === 'SessionEnd' || incoming.payload.state !== 'working')
  )
}

/** The relay's replay cache carries the pane's owner on each row; hook bytes never grant or end it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  if (previous?.agentPresence?.ended) {
    // Why: a replay restates the ended owner's own history; a live hook is a turn of whatever runs now.
    return incoming.isReplay ? undefined : { ...incoming, agentPresence: undefined }
  }
  return { ...incoming, agentPresence: previous?.agentPresence }
}
