import type { AgentProviderSessionMetadata } from '../agent-session-resume'
import { hermesStateDbProfile } from '../../../agent-launch/startup/hermes-profile'

/** Agents whose transcript file, not only the session id, names the conversation they resume. */
export function providerSessionLocatorIdentifies(agent: string | undefined): boolean {
  return agent === 'pi' || agent === 'prime-agent'
}

/** The store a Hermes resume target names: its live profile, its history row's state.db path,
 *  or the root home when neither is recorded. Session ids are only unique inside one store. */
function hermesResumeStore(session: AgentProviderSessionMetadata): string {
  return session.hermesProfile ?? hermesStateDbProfile(session.transcriptPath) ?? 'default'
}

/** Compare the provider-owned values that identify the CLI resume target.
 *  Pi-family transcript resumes use file identity; other agents use provider ids. Two Hermes
 *  profiles (or history rows) holding one id resume different turns in different stores. */
export function agentProviderSessionsEqual(
  agent: string | undefined,
  left: AgentProviderSessionMetadata | undefined,
  right: AgentProviderSessionMetadata | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.key === right.key &&
    left.id === right.id &&
    (!providerSessionLocatorIdentifies(agent) || left.transcriptPath === right.transcriptPath) &&
    (agent !== 'hermes' || hermesResumeStore(left) === hermesResumeStore(right))
  )
}
