import { translate } from '@/i18n/i18n'
import type { AgentMapTimeField } from './agent-map-time-filter'

export function timeFieldLabel(field: AgentMapTimeField): string {
  switch (field) {
    case 'lifespan':
      return translate('dashboardPopout.map.filters.lifespan', 'Session lifespan')
    case 'sinceMessage':
      return translate('dashboardPopout.map.filters.sinceMessage', 'Since last message')
    case 'timeInState':
      return translate('dashboardPopout.map.filters.timeInState', 'Time in current state')
  }
}
