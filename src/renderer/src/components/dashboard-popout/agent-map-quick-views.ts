import { translate } from '@/i18n/i18n'
import type { DashboardCardHostKind } from '../../../../shared/dashboard-snapshot'
import { ALL_AGENT_MAP_HOSTS, type AgentMapState } from './agent-map-filter'
import {
  AGENT_MAP_TIME_MAX_INDEX,
  fullAgentMapTimeRanges,
  type AgentMapTimeRanges
} from './agent-map-time-filter'

export type AgentMapQuickViewId =
  | 'everything'
  | 'attention'
  | 'stuck'
  | 'unread'
  | 'recent'
  | 'longRunning'
  | 'stale'
  | 'orchestration'

export type AgentMapFilterState = {
  states: ReadonlySet<AgentMapState>
  hosts: ReadonlySet<DashboardCardHostKind>
  agentTypes: ReadonlySet<string>
  timeRanges: AgentMapTimeRanges
  unreadOnly: boolean
  orchestrationOnly: boolean
}

export const ALL_AGENT_MAP_STATES: readonly AgentMapState[] = [
  'attention',
  'working',
  'done',
  'idle'
]

/** Stop indices used by the quick views, named so the intent survives a re-scale. */
const STOP_30_MIN = 4
const STOP_1_DAY = 9
const STOP_3_DAY = 11

export function emptyAgentMapFilterState(agentTypes: readonly string[]): AgentMapFilterState {
  return {
    states: new Set(ALL_AGENT_MAP_STATES),
    hosts: new Set(ALL_AGENT_MAP_HOSTS),
    agentTypes: new Set(agentTypes),
    timeRanges: fullAgentMapTimeRanges(),
    unreadOnly: false,
    orchestrationOnly: false
  }
}

export const AGENT_MAP_QUICK_VIEWS: readonly {
  id: AgentMapQuickViewId
  label: () => string
  apply: (base: AgentMapFilterState) => AgentMapFilterState
}[] = [
  {
    id: 'everything',
    label: () => translate('dashboardPopout.map.quickView.everything', 'Everything'),
    apply: (base) => base
  },
  {
    id: 'attention',
    label: () => translate('dashboardPopout.map.quickView.attention', 'Needs me'),
    apply: (base) => ({ ...base, states: new Set<AgentMapState>(['attention', 'done']) })
  },
  {
    id: 'stuck',
    label: () => translate('dashboardPopout.map.quickView.stuck', 'Stuck'),
    apply: (base) => ({
      ...base,
      states: new Set<AgentMapState>(['working']),
      timeRanges: {
        ...base.timeRanges,
        sinceMessage: { min: STOP_30_MIN, max: AGENT_MAP_TIME_MAX_INDEX }
      }
    })
  },
  {
    id: 'unread',
    label: () => translate('dashboardPopout.map.quickView.unread', 'Unread'),
    apply: (base) => ({ ...base, unreadOnly: true })
  },
  {
    id: 'recent',
    label: () => translate('dashboardPopout.map.quickView.recent', 'Last 30 min'),
    apply: (base) => ({
      ...base,
      timeRanges: { ...base.timeRanges, sinceMessage: { min: 0, max: STOP_30_MIN } }
    })
  },
  {
    id: 'longRunning',
    label: () => translate('dashboardPopout.map.quickView.longRunning', 'Long runners'),
    apply: (base) => ({
      ...base,
      states: new Set<AgentMapState>(['attention', 'working']),
      timeRanges: {
        ...base.timeRanges,
        lifespan: { min: STOP_1_DAY, max: AGENT_MAP_TIME_MAX_INDEX }
      }
    })
  },
  {
    id: 'stale',
    label: () => translate('dashboardPopout.map.quickView.stale', 'Stale > 3d'),
    apply: (base) => ({
      ...base,
      timeRanges: {
        ...base.timeRanges,
        sinceMessage: { min: STOP_3_DAY, max: AGENT_MAP_TIME_MAX_INDEX }
      }
    })
  },
  {
    id: 'orchestration',
    label: () => translate('dashboardPopout.map.quickView.orchestration', 'Orchestration'),
    apply: (base) => ({ ...base, orchestrationOnly: true })
  }
]

/** Quick views replace the filters wholesale; they are a starting point, not a
 *  toggle stacked on whatever was already set. */
export function applyAgentMapQuickView(
  id: AgentMapQuickViewId,
  agentTypes: readonly string[]
): AgentMapFilterState {
  const view = AGENT_MAP_QUICK_VIEWS.find((candidate) => candidate.id === id)
  const base = emptyAgentMapFilterState(agentTypes)
  return view ? view.apply(base) : base
}
