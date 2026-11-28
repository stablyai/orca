import {
  isSameAgentProcess,
  type AgentProcessIdentity
} from '../../../agent-status/process/agent-process-presence'
import type { AgentHookEventPayload } from '../../listener-event'

/** Only a live row with a captured process can challenge another sender. */
export function droidRowOwner(
  previous: AgentHookEventPayload | undefined
): AgentProcessIdentity | undefined {
  const presence = previous?.agentPresence
  return presence && !presence.ended && !previous?.providerSessionOnly
    ? presence.process
    : undefined
}

export function isForeignDroidSender(
  previous: AgentHookEventPayload | undefined,
  sender: AgentProcessIdentity | undefined
): boolean {
  const owner = droidRowOwner(previous)
  return owner !== undefined && !(sender && isSameAgentProcess(owner, sender))
}

/** Late hooks from an ended owner cannot revive its row. */
export function isEndedDroidOwner(
  previous: AgentHookEventPayload | undefined,
  sender: AgentProcessIdentity | undefined
): boolean {
  const presence = previous?.agentPresence
  return Boolean(
    presence?.ended && presence.process && sender && isSameAgentProcess(presence.process, sender)
  )
}
