import { useEffect, useRef } from 'react'
import type { AgentMapAgentNode } from './agent-map-layout'
import type { AgentMapViewport } from './agent-map-viewport-transition'

type AgentMapSelectedFocusOptions = {
  agents: AgentMapAgentNode[]
  selectedPaneKey: string | null
  viewportRef: { current: AgentMapViewport }
  resolveFocusViewport: (agent: AgentMapAgentNode) => AgentMapViewport
  animateViewport: (from: AgentMapViewport, to: AgentMapViewport) => void
  stopViewportTransition: () => void
}

export function useAgentMapSelectedFocus({
  agents,
  selectedPaneKey,
  viewportRef,
  resolveFocusViewport,
  animateViewport,
  stopViewportTransition
}: AgentMapSelectedFocusOptions): void {
  const focusedAgentRef = useRef<{
    paneKey: string
    x: number
    y: number
    zoom: number
  } | null>(null)
  useEffect(() => {
    const selected = agents.find((agent) => agent.card.paneKey === selectedPaneKey)
    if (!selectedPaneKey || !selected) {
      focusedAgentRef.current = null
      stopViewportTransition()
      return
    }
    const target = resolveFocusViewport(selected)
    const focused = focusedAgentRef.current
    if (
      focused?.paneKey === selectedPaneKey &&
      focused.x === target.center.x &&
      focused.y === target.center.y &&
      focused.zoom === target.zoom
    ) {
      return
    }
    focusedAgentRef.current = {
      paneKey: selectedPaneKey,
      x: target.center.x,
      y: target.center.y,
      zoom: target.zoom
    }
    animateViewport(viewportRef.current, target)
  }, [
    agents,
    animateViewport,
    resolveFocusViewport,
    selectedPaneKey,
    stopViewportTransition,
    viewportRef
  ])
}
