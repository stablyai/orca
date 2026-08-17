import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { agentName } from './agent-map-agent-name'

export const AGENT_MAP_AGENT_LABEL_FRAME_WIDTH = 84
export const AGENT_MAP_AGENT_LABEL_NODE_GAP = 5
export const AGENT_MAP_AGENT_LABEL_FONT_SIZE = 11
export const AGENT_MAP_AGENT_LABEL_MIN_RENDERED_FONT_SIZE = 9
const AGENT_MAP_AGENT_LABEL_MAX_FRAME_WIDTH = 500
const AGENT_MAP_AGENT_LABEL_MAX_LINES = 24
const AGENT_MAP_AGENT_LABEL_MAX_VISIBLE_LINES = 12
const READABLE_LABEL_PACKING_AGENT_LIMIT = 20
const AGENT_MAP_AGENT_LABEL_MAX_GLYPH_WIDTH = 11
const AGENT_MAP_AGENT_LABEL_HORIZONTAL_CHROME = 12
const AGENT_MAP_AGENT_LABEL_LINE_HEIGHT = 13
const AGENT_MAP_AGENT_LABEL_VERTICAL_CHROME = 6
export const AGENT_MAP_AGENT_LABEL_MIN_HEIGHT = 20

export type AgentMapAgentLabelMetrics = {
  width: number
  height: number
}

export function agentMapAgentLabelScale(mapScale: number): number {
  return Math.max(
    1,
    AGENT_MAP_AGENT_LABEL_MIN_RENDERED_FONT_SIZE /
      (AGENT_MAP_AGENT_LABEL_FONT_SIZE * Math.max(Number.EPSILON, mapScale))
  )
}

export function agentMapAgentLabelLayoutScale(agentCount: number): number {
  // Dense views cannot keep every label readable, so retain compact fallback packing.
  return agentCount <= READABLE_LABEL_PACKING_AGENT_LIMIT ? agentMapAgentLabelScale(480 / 900) : 1
}

const metricsCache = new WeakMap<
  DashboardCard,
  { name: string; metrics: AgentMapAgentLabelMetrics }
>()

function wrappedLineCount(name: string, charactersPerLine: number): number {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  let lineCount = 1
  let used = 0

  for (const word of words) {
    let remaining = Array.from(word).length
    if (used > 0) {
      if (used + 1 + remaining <= charactersPerLine) {
        used += 1 + remaining
        continue
      }
      lineCount += 1
      used = 0
    }
    lineCount += Math.floor((remaining - 1) / charactersPerLine)
    remaining = ((remaining - 1) % charactersPerLine) + 1
    used = remaining
  }

  return lineCount
}

function lineCapacity(width: number): number {
  return Math.max(
    1,
    Math.floor(
      (width - AGENT_MAP_AGENT_LABEL_HORIZONTAL_CHROME) / AGENT_MAP_AGENT_LABEL_MAX_GLYPH_WIDTH
    )
  )
}

function metricsForName(name: string): AgentMapAgentLabelMetrics {
  let minimum = AGENT_MAP_AGENT_LABEL_FRAME_WIDTH
  let maximum = AGENT_MAP_AGENT_LABEL_MAX_FRAME_WIDTH
  while (minimum < maximum) {
    const midpoint = Math.floor((minimum + maximum) / 2)
    if (wrappedLineCount(name, lineCapacity(midpoint)) <= AGENT_MAP_AGENT_LABEL_MAX_LINES) {
      maximum = midpoint
    } else {
      minimum = midpoint + 1
    }
  }
  const width = Math.max(AGENT_MAP_AGENT_LABEL_FRAME_WIDTH, minimum)
  const lineCount = wrappedLineCount(name, lineCapacity(width))
  return {
    width,
    height: Math.max(
      AGENT_MAP_AGENT_LABEL_MIN_HEIGHT,
      Math.min(lineCount, AGENT_MAP_AGENT_LABEL_MAX_VISIBLE_LINES) *
        AGENT_MAP_AGENT_LABEL_LINE_HEIGHT +
        AGENT_MAP_AGENT_LABEL_VERTICAL_CHROME
    )
  }
}

export function agentMapAgentLabelMetrics(card: DashboardCard): AgentMapAgentLabelMetrics {
  const name = agentName(card)
  const cached = metricsCache.get(card)
  if (cached?.name === name) {
    return cached.metrics
  }
  const metrics = metricsForName(name)
  metricsCache.set(card, { name, metrics })
  return metrics
}
