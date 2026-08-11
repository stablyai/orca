import { useCallback, useState } from 'react'
import type { AgentMapState } from './agent-map-filter'

const ALL_AGENT_STATES: AgentMapState[] = ['attention', 'working', 'done', 'idle']

/** Map-only state muting. It lives on the board rather than inside the map so
 *  the shared toolbar filter — the map has no rail of its own — can drive it. */
export function useAgentMapStateFilter(): {
  agentStates: ReadonlySet<AgentMapState>
  toggleAgentState: (state: AgentMapState) => void
  resetAgentStates: () => void
} {
  const [agentStates, setAgentStates] = useState<ReadonlySet<AgentMapState>>(
    () => new Set(ALL_AGENT_STATES)
  )
  const toggleAgentState = useCallback((state: AgentMapState): void => {
    setAgentStates((current) => {
      const next = new Set(current)
      if (!next.delete(state)) {
        next.add(state)
      }
      return next
    })
  }, [])
  const resetAgentStates = useCallback((): void => {
    setAgentStates(new Set(ALL_AGENT_STATES))
  }, [])
  return { agentStates, toggleAgentState, resetAgentStates }
}
