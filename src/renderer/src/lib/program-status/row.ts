import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { agentTypeToIconAgent } from '@/lib/agent-status'

type ProgramStatusRowSource = Pick<
  AgentStatusEntry,
  'state' | 'sessionBoundary' | 'agentType' | 'programStatus' | 'observation'
>

/** A row a generic OSC 7501 program reported, not a real agent (claude, codex, …). */
export function isProgramStatusRow(
  entry: Partial<Pick<AgentStatusEntry, 'agentType' | 'programStatus' | 'observation'>>
): boolean {
  if (agentTypeToIconAgent(entry.agentType)) {
    return false
  }
  // Why the origin fallback: facets are live-only (a restart drops them); only OSC writes a non-agent `osc` row.
  return entry.programStatus !== undefined || entry.observation?.origin === 'osc'
}

/** A finished program's result the command-finished drop keeps (not an interrupted program's). */
export function isRetainedProgramResult(entry: ProgramStatusRowSource): boolean {
  if (entry.state !== 'done' || entry.sessionBoundary === true || !isProgramStatusRow(entry)) {
    return false
  }
  const facetState = entry.programStatus?.state
  return facetState === undefined || facetState === 'done' || facetState === 'error'
}
