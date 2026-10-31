import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'
import type {
  AgentSessionAnyRefusalDetails,
  AgentSessionRefusalDetails
} from './agent-session-refusal-details'

/** Facts only a live reply carries, never saved history: a switch's own source pane still writes
 *  the conversation. A refusal reduced to a reference drops them. */
type AgentSessionReplyOnlyFactsByCode = {
  agent_session_conflict: { source?: true }
  agent_session_ownership_unknown: { source?: true }
}
export type AgentSessionReplyOnlyFacts<C extends AgentSessionWireRefusalCode> =
  C extends keyof AgentSessionReplyOnlyFactsByCode
    ? AgentSessionReplyOnlyFactsByCode[C]
    : Record<never, never>
export type AgentSessionReplyRefusalDetails<C extends AgentSessionWireRefusalCode> =
  AgentSessionRefusalDetails<C> & AgentSessionReplyOnlyFacts<C>
export type AgentSessionAnyReplyRefusalDetails =
  AgentSessionReplyRefusalDetails<AgentSessionWireRefusalCode>

/** Details as saved history may hold them: without the reply-only facts. */
export function savedAgentSessionRefusalDetails(
  details: AgentSessionAnyReplyRefusalDetails
): AgentSessionAnyRefusalDetails {
  return 'source' in details
    ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'source'))
    : details
}
