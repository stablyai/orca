import type { AgentProviderSessionMetadata } from './agent-session-resume'

/** Agents whose transcript file, not only the session id, names the conversation they resume. */
export function providerSessionLocatorIdentifies(agent: string | undefined): boolean {
  return agent === 'pi' || agent === 'prime-agent'
}

/** Compare the provider-owned values that identify the CLI resume target.
 *  Pi-family transcript resumes use file identity; other agents use provider ids. */
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
    (!providerSessionLocatorIdentifies(agent) || left.transcriptPath === right.transcriptPath)
  )
}
