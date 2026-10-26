import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import {
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from '../../../../shared/program-status/facet'

export function createAgentStatusProgramStatusActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'setAgentProgramStatus'> {
  const { get, setEntry } = runtime
  return {
    setAgentProgramStatus: (paneKey: string, programStatus: ProgramStatusFacet | null) => {
      paneKey = runtime.authority().resolveAgentPaneAuthorityKey(paneKey)
      const existing = get().agentStatusByPaneKey[paneKey]
      if (
        !existing ||
        programStatusFacetsEqual(existing.programStatus, programStatus ?? undefined)
      ) {
        return false
      }
      const { programStatus: _previous, ...rest } = existing
      setEntry(paneKey, programStatus ? { ...rest, programStatus } : rest)
      return true
    }
  }
}
