import { collectAgentTitleEvidence } from './agent-title-evidence'

/** Whether `title` presents `agent` as its identity (vendor marker or anchored name), not a mention. */
export function titlePresentsAgentIdentity(
  title: string,
  agent: string | null | undefined
): boolean {
  if (!agent) {
    return false
  }
  const evidence = collectAgentTitleEvidence(title)
  return (
    (evidence.reason === 'vendor-marker' || evidence.reason === 'anchored') &&
    evidence.agent === agent
  )
}
