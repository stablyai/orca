/** The extension's agent_start for a newly started child; new work, unlike late events of a cancelled run. */
export const PI_SUBAGENT_START_EVENT = 'agent_start:subagent'

export function restatePiFamilyEventName(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): unknown {
  return eventName === 'agent_start' && hookPayload.subagent_started === true
    ? PI_SUBAGENT_START_EVENT
    : eventName
}
