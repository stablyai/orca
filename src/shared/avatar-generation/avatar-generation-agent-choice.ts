import type { AvatarImageAgent, AvatarImageAgentStatus } from './avatar-generation-contract'

/**
 * The agent Generate runs with: one picked in its menu while it is offered; else the remembered one
 * while it is ready; else the first ready; else the remembered or first one, signed out, so the field
 * can say which to sign in to.
 */
export function pickAvatarAgent(
  agents: readonly AvatarImageAgentStatus[],
  { chosen, remembered }: { chosen?: AvatarImageAgent | null; remembered?: AvatarImageAgent | null }
): AvatarImageAgent | null {
  const offered = (agent: AvatarImageAgent | null | undefined) =>
    agents.find((entry) => entry.agent === agent)
  return (
    offered(chosen)?.agent ??
    (offered(remembered)?.status === 'ready' ? (remembered ?? null) : null) ??
    agents.find((entry) => entry.status === 'ready')?.agent ??
    offered(remembered)?.agent ??
    agents[0]?.agent ??
    null
  )
}

/** Whether `agent` can run now: offered and signed in. */
export function avatarAgentReady(
  agents: readonly AvatarImageAgentStatus[],
  agent: AvatarImageAgent | null
): boolean {
  return agents.some((entry) => entry.agent === agent && entry.status === 'ready')
}
