// The agent provider's own remote access to a chat (Claude Code's Remote Control), not Orca's SSH
// runtime control, which owns the plain `remoteControl` names.

export type AgentSessionProviderRemoteControlState =
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'policy-disabled'

/** Live and memory-only: it lasts as long as the provider process that reported it. */
export type AgentSessionProviderRemoteControl = {
  state: AgentSessionProviderRemoteControlState
  /** The provider's page for this chat; absent until the provider answers. */
  sessionUrl?: string
  /** The provider's words for a failed or policy-disabled link. */
  detail?: string
  /** Connected by an organization or rollout default rather than the person's own setting, so
   *  every client must say so. */
  enabledByDefault?: true
}

/** The person's saved choice for one chat; absent follows the global setting. */
export type AgentSessionProviderRemoteControlChoice = 'on' | 'off'

export function isAgentSessionProviderRemoteControlChoice(
  value: unknown
): value is AgentSessionProviderRemoteControlChoice {
  return value === 'on' || value === 'off'
}

export function agentSessionProviderRemoteControlsEqual(
  a: AgentSessionProviderRemoteControl | undefined,
  b: AgentSessionProviderRemoteControl | undefined
): boolean {
  return (
    a?.state === b?.state &&
    a?.sessionUrl === b?.sessionUrl &&
    a?.detail === b?.detail &&
    a?.enabledByDefault === b?.enabledByDefault
  )
}

/** `agentSession.providerRemoteControl`: what the chat has after any choice the call saved. */
export type AgentSessionProviderRemoteControlResult =
  | { status: 'unsupported' }
  | {
      status: 'ok'
      choice?: AgentSessionProviderRemoteControlChoice
      /** Whether a running agent took the choice now; otherwise its next start applies it. */
      live: boolean
      link?: AgentSessionProviderRemoteControl
    }

type RemoteControlLinkAndChoice = {
  link: AgentSessionProviderRemoteControl | undefined
  choice: AgentSessionProviderRemoteControlChoice | undefined
}

/** Whether a toggle turns it off: a live link, or the person's "on" waiting for the agent to start.
 *  A policy refusal left nothing on. */
export function agentSessionProviderRemoteControlIsOn({
  link,
  choice
}: RemoteControlLinkAndChoice): boolean {
  return link ? link.state !== 'policy-disabled' : choice === 'on'
}

/** Turned on for a chat whose agent is not running: it connects when the agent next starts. */
export function agentSessionProviderRemoteControlIsPending({
  link,
  choice
}: RemoteControlLinkAndChoice): boolean {
  return !link && choice === 'on'
}
