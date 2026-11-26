import type { AvatarImageAgent, AvatarImageAgentStatus } from './avatar-generation-contract'

/** The agent Generate opens on: the remembered one while it is offered, else the first ready, else the first. */
export function pickAvatarAgent(
  agents: readonly AvatarImageAgentStatus[],
  preferred: AvatarImageAgent | null | undefined
): AvatarImageAgent | null {
  return (
    agents.find((entry) => entry.agent === preferred)?.agent ??
    agents.find((entry) => entry.status === 'ready')?.agent ??
    agents[0]?.agent ??
    null
  )
}
