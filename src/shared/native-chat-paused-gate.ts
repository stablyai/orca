import type { AgentStatusState } from './agent-status-types'

/** The gate both chat surfaces put status-derived interactive prompts behind.
 *  The host keeps `interactivePrompt` sticky, so an approval or ask envelope
 *  outlives its answer: only an agent parked on the user may surface a card from
 *  it, never a working or done one. Transcript-derived prompts stay outside the
 *  gate — they clear on their own tool result. */
export function isAgentPausedOnUser(state: AgentStatusState | null | undefined): boolean {
  return state === 'waiting' || state === 'blocked'
}
