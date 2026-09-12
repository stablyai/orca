import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { FilterAgentIds } from '../../../../shared/workspace-agent-filter'

export function getSidebarAgentVisibilityLabel(
  visibleAgentIds: FilterAgentIds,
  catalog: readonly { id: TuiAgent; label: string }[]
): string {
  if (!visibleAgentIds || visibleAgentIds.length === catalog.length) {
    return translate('auto.components.sidebar.sidebarAgentOptions.allAgents', 'All agents')
  }
  if (visibleAgentIds.length === 1) {
    return catalog.find((agent) => agent.id === visibleAgentIds[0])?.label ?? 'Agent'
  }
  return translate(
    'auto.components.sidebar.sidebarAgentOptions.visibleAgentsCount',
    '{{value0}} agents',
    { value0: visibleAgentIds.length }
  )
}
