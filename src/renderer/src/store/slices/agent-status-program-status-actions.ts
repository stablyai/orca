import type { AgentStatusSlice } from './agent-status/agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import {
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from '../../../../shared/program-status/facet'
import { resolveAgentPaneAuthorityKey } from './agent-pane-authority'

export function createAgentStatusProgramStatusActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'setAgentProgramStatus'> {
  const { set } = runtime
  return {
    setAgentProgramStatus: (paneKey: string, programStatus: ProgramStatusFacet | null) => {
      paneKey = resolveAgentPaneAuthorityKey(paneKey)
      let changed = false
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        // Why no row creation: the facet rides an existing row and never decides one exists.
        if (
          !existing ||
          programStatusFacetsEqual(existing.programStatus, programStatus ?? undefined)
        ) {
          return s
        }
        changed = true
        const { programStatus: _previous, ...rest } = existing
        // Why the entry alone: timing, history, sort and attention must not read a facet tick as news.
        return {
          agentStatusByPaneKey: {
            ...s.agentStatusByPaneKey,
            [paneKey]: programStatus ? { ...rest, programStatus } : rest
          }
        }
      })
      return changed
    }
  }
}
