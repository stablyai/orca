import { useEffect, useRef } from 'react'
import type { AgentMapAgentNode } from './agent-map-layout'
import type { AgentMapViewport } from './agent-map-viewport-transition'

type AgentMapSelectedFocusOptions = {
  agents: AgentMapAgentNode[]
  selectedPaneKey: string | null
  viewportRef: { current: AgentMapViewport }
  resolveFocusZoom: () => number
  animateViewport: (from: AgentMapViewport, to: AgentMapViewport) => void
  stopViewportTransition: () => void
}

export function useAgentMapSelectedFocus({
  agents,
  selectedPaneKey,
  viewportRef,
  resolveFocusZoom,
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
    const targetZoom = resolveFocusZoom()
    const focused = focusedAgentRef.current
    if (
      focused?.paneKey === selectedPaneKey &&
      focused.x === selected.x &&
      focused.y === selected.y &&
      focused.zoom === targetZoom
    ) {
      return
    }
    focusedAgentRef.current = {
      paneKey: selectedPaneKey,
      x: selected.x,
      y: selected.y,
      zoom: targetZoom
    }
    animateViewport(viewportRef.current, {
      center: { x: selected.x, y: selected.y },
      zoom: targetZoom
    })
  }, [
    agents,
    animateViewport,
    resolveFocusZoom,
    selectedPaneKey,
    stopViewportTransition,
    viewportRef
  ])
}
