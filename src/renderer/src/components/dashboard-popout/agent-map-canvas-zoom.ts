import {
  agentMapAgentLabelBounds,
  agentMapAgentLabelPlacements
} from './agent-map-agent-label-layout'
import { agentMapAgentLabelScale } from './agent-map-agent-label-metrics'
export { agentMapAgentLabelScale } from './agent-map-agent-label-metrics'
import {
  AGENT_MAP_AGENT_RADIUS,
  type AgentMapAgentNode,
  type AgentMapLayout
} from './agent-map-layout'
import { agentName } from './agent-map-agent-name'
import {
  PRIORITY_WORKTREE_LABEL_PROJECT_LIMIT,
  agentMapProjectLabelBoxes,
  agentMapPriorityWorktreeLabelIds,
  agentMapVisibleWorktreeLabelBoxes
} from './agent-map-label-declutter'
import { navigableAgentMapAgents } from './agent-map-navigation'
import type { AgentMapViewport } from './agent-map-viewport-transition'

export const MIN_ZOOM = 0.7
export const MAX_ZOOM = 24

/** Screen radius a single agent should occupy once focused. */
const AGENT_FOCUS_RADIUS_PX = 24
const FIT_PADDING_PX = 4
const LABEL_FIT_SCAN_STEPS = 128
const LABEL_FIT_REFINEMENT_STEPS = 12
const FOCUS_FIT_PADDING_PX = 12
const FOCUS_FIT_ITERATIONS = 8
const BASE_WIDTH_CACHE_LIMIT = 8
const baseWidthCache = new Map<string, number>()

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function labelFitAtScale(
  layout: AgentMapLayout,
  agents: readonly AgentMapAgentNode[],
  mapScale: number,
  width: number,
  height: number
): { fits: boolean; overflow: number } {
  const projectLabelScale = Math.max(1, 1 / mapScale)
  const agentLabelScale = agentMapAgentLabelScale(mapScale)
  const projectBoxes = agentMapProjectLabelBoxes(layout, projectLabelScale, mapScale)
  const visibleWorktreeIds = agentMapPriorityWorktreeLabelIds(layout, projectLabelScale, mapScale)
  const obstacles = [
    ...projectBoxes,
    ...agentMapVisibleWorktreeLabelBoxes(layout, projectLabelScale, mapScale, visibleWorktreeIds)
  ]
  const bounds = agentMapAgentLabelBounds(
    agentMapAgentLabelPlacements(agents, agentLabelScale, obstacles)
  )
  if (!bounds) {
    return { fits: true, overflow: 0 }
  }
  const centerX = layout.width / 2
  const centerY = layout.height / 2
  const left = (bounds.left - centerX) * mapScale + width / 2
  const right = (bounds.right - centerX) * mapScale + width / 2
  const top = (bounds.top - centerY) * mapScale + height / 2
  const bottom = (bounds.bottom - centerY) * mapScale + height / 2
  const overflow = Math.max(
    FIT_PADDING_PX - left,
    right - (width - FIT_PADDING_PX),
    FIT_PADDING_PX - top,
    bottom - (height - FIT_PADDING_PX),
    0
  )
  return { fits: overflow === 0, overflow }
}

function fittingLabelScale(
  layout: AgentMapLayout,
  agents: readonly AgentMapAgentNode[],
  geometryScale: number,
  width: number,
  height: number
): number {
  if (labelFitAtScale(layout, agents, geometryScale, width, height).fits) {
    return geometryScale
  }

  const minimumScale = geometryScale / MAX_ZOOM
  let clippedScale = geometryScale
  let bestScale = minimumScale
  let bestOverflow = Number.POSITIVE_INFINITY
  for (let step = 1; step <= LABEL_FIT_SCAN_STEPS; step += 1) {
    const remaining = 1 - step / LABEL_FIT_SCAN_STEPS
    const candidate = minimumScale + (geometryScale - minimumScale) * remaining * remaining
    const result = labelFitAtScale(layout, agents, candidate, width, height)
    if (result.overflow < bestOverflow) {
      bestScale = candidate
      bestOverflow = result.overflow
    }
    if (!result.fits) {
      clippedScale = candidate
      continue
    }

    let fittingScale = candidate
    for (let refinement = 0; refinement < LABEL_FIT_REFINEMENT_STEPS; refinement += 1) {
      const midpoint = (fittingScale + clippedScale) / 2
      if (labelFitAtScale(layout, agents, midpoint, width, height).fits) {
        fittingScale = midpoint
      } else {
        clippedScale = midpoint
      }
    }
    return fittingScale
  }
  return bestScale
}

function agentMapFitGeometryKey(
  layout: AgentMapLayout,
  width: number,
  height: number,
  allowAggregation: boolean,
  selectedPaneKey: string | null
): string {
  const includeWorktreePriority = layout.projects.length <= PRIORITY_WORKTREE_LABEL_PROJECT_LIMIT
  return JSON.stringify([
    layout.topologyKey,
    layout.width,
    layout.height,
    width,
    height,
    allowAggregation,
    selectedPaneKey,
    layout.projects.map((project) => [
      project.id,
      project.name,
      project.x,
      project.y,
      project.radius,
      project.worktrees.map((worktree) => [
        worktree.id,
        worktree.name,
        worktree.x,
        worktree.y,
        worktree.radius,
        worktree.quiet,
        worktree.hostKind,
        worktree.executionHostId,
        includeWorktreePriority
          ? [
              worktree.statusCounts.blocked,
              worktree.statusCounts.waiting,
              worktree.statusCounts.working
            ]
          : null,
        worktree.agents.map((agent) => [
          agent.card.paneKey,
          agent.x,
          agent.y,
          agent.radius,
          agentName(agent.card)
        ])
      ])
    ])
  ])
}

function cacheBaseWidth(key: string, baseWidth: number): void {
  if (baseWidthCache.size >= BASE_WIDTH_CACHE_LIMIT) {
    const oldestKey = baseWidthCache.keys().next().value
    if (oldestKey !== undefined) {
      baseWidthCache.delete(oldestKey)
    }
  }
  baseWidthCache.set(key, baseWidth)
}

export function agentMapBaseWidth(
  layout: AgentMapLayout,
  width: number,
  height: number,
  allowAggregation = true,
  selectedPaneKey: string | null = null
): number {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const cacheKey = agentMapFitGeometryKey(
    layout,
    safeWidth,
    safeHeight,
    allowAggregation,
    selectedPaneKey
  )
  const cached = baseWidthCache.get(cacheKey)
  if (cached !== undefined) {
    baseWidthCache.delete(cacheKey)
    baseWidthCache.set(cacheKey, cached)
    return cached
  }
  const aspect = safeWidth / safeHeight
  const agents = navigableAgentMapAgents(layout, 1, allowAggregation, selectedPaneKey)
  const geometryBaseWidth = Math.max(layout.width, layout.height * aspect)
  const geometryScale = safeWidth / geometryBaseWidth
  const fittingScale = fittingLabelScale(layout, agents, geometryScale, safeWidth, safeHeight)
  const baseWidth = safeWidth / fittingScale
  cacheBaseWidth(cacheKey, baseWidth)
  return baseWidth
}

export function agentFocusZoomForBaseWidth(baseWidth: number, width: number): number {
  return clamp(
    Math.max(
      2,
      (baseWidth * AGENT_FOCUS_RADIUS_PX) / (Math.max(1, width) * AGENT_MAP_AGENT_RADIUS)
    ),
    MIN_ZOOM,
    MAX_ZOOM
  )
}

export function agentFocusViewport(
  layout: AgentMapLayout,
  selected: AgentMapAgentNode,
  baseWidth: number,
  width: number,
  height: number,
  allowAggregation: boolean
): AgentMapViewport {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  let zoom = agentFocusZoomForBaseWidth(baseWidth, safeWidth)
  let center = { x: selected.x, y: selected.y }

  for (let iteration = 0; iteration < FOCUS_FIT_ITERATIONS; iteration += 1) {
    const mapScale = (safeWidth * zoom) / baseWidth
    const projectLabelScale = Math.max(1, 1 / mapScale)
    const agentLabelScale = agentMapAgentLabelScale(mapScale)
    const projectBoxes = agentMapProjectLabelBoxes(layout, projectLabelScale, mapScale)
    const visibleWorktreeIds = agentMapPriorityWorktreeLabelIds(layout, projectLabelScale, mapScale)
    const placement = agentMapAgentLabelPlacements(
      navigableAgentMapAgents(layout, zoom, allowAggregation, selected.card.paneKey),
      agentLabelScale,
      [
        ...projectBoxes,
        ...agentMapVisibleWorktreeLabelBoxes(
          layout,
          projectLabelScale,
          mapScale,
          visibleWorktreeIds
        )
      ]
    ).get(selected.card.paneKey)
    if (!placement) {
      break
    }
    const left = Math.min(selected.x - selected.radius, placement.bounds.left)
    const right = Math.max(selected.x + selected.radius, placement.bounds.right)
    const top = Math.min(selected.y - selected.radius, placement.bounds.top)
    const bottom = Math.max(selected.y + selected.radius, placement.bounds.bottom)
    center = { x: (left + right) / 2, y: (top + bottom) / 2 }
    const fitRatio = Math.min(
      (safeWidth - FOCUS_FIT_PADDING_PX * 2) / ((right - left) * mapScale),
      (safeHeight - FOCUS_FIT_PADDING_PX * 2) / ((bottom - top) * mapScale)
    )
    if (fitRatio >= 1) {
      break
    }
    zoom = clamp(zoom * fitRatio, MIN_ZOOM, MAX_ZOOM)
  }

  return { center, zoom }
}

/** Zoom that brings one agent up to `AGENT_FOCUS_RADIUS_PX` on screen. */
export function agentFocusZoom(layout: AgentMapLayout, width: number, height: number): number {
  return agentFocusZoomForBaseWidth(agentMapBaseWidth(layout, width, height), width)
}
