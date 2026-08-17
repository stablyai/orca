import { useCallback, useMemo } from 'react'
import type { AgentMapAgentNode, AgentMapLayout } from './agent-map-layout'
import { agentFocusViewport, agentMapBaseWidth } from './agent-map-canvas-zoom'
import type { AgentMapViewport } from './agent-map-viewport-transition'

export function useAgentMapFitGeometry(
  layout: AgentMapLayout,
  width: number,
  height: number,
  allowAggregation: boolean,
  selectedPaneKey: string | null
): {
  baseWidth: number
  resolveFocusViewport: (agent: AgentMapAgentNode) => AgentMapViewport
} {
  const baseWidth = useMemo(
    () => agentMapBaseWidth(layout, width, height, allowAggregation, selectedPaneKey),
    [allowAggregation, height, layout, selectedPaneKey, width]
  )
  const resolveFocusViewport = useCallback(
    (agent: AgentMapAgentNode): AgentMapViewport =>
      agentFocusViewport(layout, agent, baseWidth, width, height, allowAggregation),
    [allowAggregation, baseWidth, height, layout, width]
  )
  return { baseWidth, resolveFocusViewport }
}
