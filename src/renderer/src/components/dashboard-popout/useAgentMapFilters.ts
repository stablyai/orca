import { useCallback, useMemo, useState } from 'react'
import type { AgentMapState } from './agent-map-filter'
import {
  applyAgentMapQuickView,
  emptyAgentMapFilterState,
  ALL_AGENT_MAP_STATES,
  type AgentMapFilterState,
  type AgentMapQuickViewId
} from './agent-map-quick-views'
import {
  activeAgentMapTimeFields,
  fullAgentMapTimeRanges,
  type AgentMapTimeField,
  type AgentMapTimeRange
} from './agent-map-time-filter'

export type AgentMapFilterControls = AgentMapFilterState & {
  activeCount: number
  toggleState: (state: AgentMapState) => void
  resetStates: () => void
  toggleAgentType: (agentType: string) => void
  setTimeRange: (field: AgentMapTimeField, range: AgentMapTimeRange) => void
  resetTimeRanges: () => void
  setUnreadOnly: (only: boolean) => void
  setOrchestrationOnly: (only: boolean) => void
  applyQuickView: (id: AgentMapQuickViewId) => void
  reset: () => void
}

type AgentMapFacetState = Omit<AgentMapFilterState, 'agentTypes'>

function toggle<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current)
  if (!next.delete(value)) {
    next.add(value)
  }
  return next
}

function mapFacets(state: AgentMapFilterState): AgentMapFacetState {
  const { agentTypes: _agentTypes, ...facets } = state
  return facets
}

/** Map-only filter state. It lives on the board rather than inside the map so
 *  the shared toolbar filter — the map has no rail of its own — can drive it. */
export function useAgentMapFilters(agentTypes: readonly string[]): AgentMapFilterControls {
  const [filters, setFilters] = useState<AgentMapFacetState>(() =>
    mapFacets(emptyAgentMapFilterState(agentTypes))
  )
  const [mutedAgentTypes, setMutedAgentTypes] = useState<ReadonlySet<string>>(() => new Set())
  const enabledAgentTypes = useMemo(
    () => new Set(agentTypes.filter((agentType) => !mutedAgentTypes.has(agentType))),
    [agentTypes, mutedAgentTypes]
  )

  const patch = useCallback(
    (next: Partial<AgentMapFacetState>) => setFilters((current) => ({ ...current, ...next })),
    []
  )

  const activeCount =
    (filters.states.size === ALL_AGENT_MAP_STATES.length ? 0 : 1) +
    (enabledAgentTypes.size === agentTypes.length ? 0 : 1) +
    activeAgentMapTimeFields(filters.timeRanges).length +
    (filters.unreadOnly ? 1 : 0) +
    (filters.orchestrationOnly ? 1 : 0)

  return {
    ...filters,
    agentTypes: enabledAgentTypes,
    activeCount,
    toggleState: useCallback(
      (state) => setFilters((c) => ({ ...c, states: toggle(c.states, state) })),
      []
    ),
    resetStates: useCallback(
      () => patch({ states: new Set<AgentMapState>(ALL_AGENT_MAP_STATES) }),
      [patch]
    ),
    toggleAgentType: useCallback(
      (agentType) => setMutedAgentTypes((current) => toggle(current, agentType)),
      []
    ),
    setTimeRange: useCallback(
      (field, range) =>
        setFilters((c) => ({ ...c, timeRanges: { ...c.timeRanges, [field]: range } })),
      []
    ),
    resetTimeRanges: useCallback(() => patch({ timeRanges: fullAgentMapTimeRanges() }), [patch]),
    setUnreadOnly: useCallback((only) => patch({ unreadOnly: only }), [patch]),
    setOrchestrationOnly: useCallback((only) => patch({ orchestrationOnly: only }), [patch]),
    applyQuickView: useCallback(
      (id) => {
        setFilters(mapFacets(applyAgentMapQuickView(id, agentTypes)))
        setMutedAgentTypes(new Set())
      },
      [agentTypes]
    ),
    reset: useCallback(() => {
      setFilters(mapFacets(emptyAgentMapFilterState(agentTypes)))
      setMutedAgentTypes(new Set())
    }, [agentTypes])
  }
}
