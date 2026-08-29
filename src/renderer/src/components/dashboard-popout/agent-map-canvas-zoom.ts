import { AGENT_MAP_AGENT_RADIUS, type AgentMapLayout } from './agent-map-layout'

export const MIN_ZOOM = 0.7
export const MAX_ZOOM = 24

/** Screen radius a single agent should occupy once focused. */
const AGENT_FOCUS_RADIUS_PX = 24

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Zoom that brings one agent up to `AGENT_FOCUS_RADIUS_PX` on screen. */
export function agentFocusZoom(layout: AgentMapLayout, width: number, height: number): number {
  const aspect = width / Math.max(1, height)
  const baseWidth = Math.max(layout.width, layout.height * aspect)
  return clamp(
    Math.max(
      2,
      (baseWidth * AGENT_FOCUS_RADIUS_PX) / (Math.max(1, width) * AGENT_MAP_AGENT_RADIUS)
    ),
    MIN_ZOOM,
    MAX_ZOOM
  )
}
