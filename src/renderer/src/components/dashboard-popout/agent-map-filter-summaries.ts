import { translate } from '@/i18n/i18n'
import {
  activeAgentMapTimeFields,
  agentMapTimeStopLabel,
  type AgentMapTimeRanges
} from './agent-map-time-filter'

export type AgentMapSectionSummary = { text: string; active: boolean }

const all = (): string => translate('dashboardPopout.map.filters.summaryAll', 'All')

/** "All" / the one selected value / "2 of 4" — enough to skip opening the row. */
export function summarizeSelection<T>(
  selected: ReadonlySet<T>,
  total: number,
  label: (value: T) => string
): AgentMapSectionSummary {
  if (selected.size >= total) {
    return { text: all(), active: false }
  }
  if (selected.size === 1) {
    return { text: label([...selected][0]), active: true }
  }
  return {
    text: translate('dashboardPopout.map.filters.summaryCount', '{{shown}} of {{total}}', {
      shown: selected.size,
      total
    }),
    active: true
  }
}

export function summarizeTimeRanges(
  ranges: AgentMapTimeRanges,
  label: (field: keyof AgentMapTimeRanges) => string
): AgentMapSectionSummary {
  const active = activeAgentMapTimeFields(ranges)
  if (active.length === 0) {
    return { text: translate('dashboardPopout.map.filters.timeAny', 'any'), active: false }
  }
  if (active.length === 1) {
    const range = ranges[active[0]]
    return {
      text: `${label(active[0])}: ${agentMapTimeStopLabel(range.min)}–${agentMapTimeStopLabel(range.max)}`,
      active: true
    }
  }
  return {
    text: translate('dashboardPopout.map.filters.timeRangeCount', '{{count}} ranges', {
      count: active.length
    }),
    active: true
  }
}
